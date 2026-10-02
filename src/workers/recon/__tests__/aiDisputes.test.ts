/**
 * AI dispute freeze + verified resolution + dataset deprecation + payout
 * gate tests (PR 25, founder AI directive + tokenization patch) — over the
 * in-memory store on the checked-in fixtures, then the same dispute
 * scenario across all three backends (parity).
 *
 * Pinned here — the brief's verifying tests:
 *   • freeze on dispute — the model's held legs flip into
 *     'unauthorized_training_hold' on filing; voice-licensing legs (never
 *     model-scoped) stay releasable; a re-file is a counted no-op;
 *   • thaw ONLY through the verified resolution path — the release path
 *     refuses a frozen leg (403, before any gate runs), the dispute's CAS
 *     resolution admits exactly one winner (the loser gets 409), a
 *     sibling active dispute keeps the model frozen, and only the last
 *     resolution thaws;
 *   • deprecation halt on rights withdrawal with clean archival — the
 *     posting pass halts a deprecated version's allocations into visible
 *     variance dust (conservation exact), the historical legs archive
 *     WITHOUT deleting or rewriting the append-only ledger rows, and a
 *     re-run converges (never double-archives);
 *   • consent and likeness gate enforcement — the AI payout gate reads
 *     the persisted states fail-closed (absent refuses as
 *     vertical_state_unknown; 'unknown' is a distinct stored state that
 *     still refuses), and only verified + released releases;
 *   • the locked Don invariants — allocations plus dust equals gross
 *     INCLUDING the held bucket, integer cents everywhere;
 *   • idempotency and the concurrency guards (the resolution CAS, the
 *     release CAS, the archive UNIQUE).
 */
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
} from "@/modules/don/constants";
import {
  evaluatePayoutCompliance,
  resolveAiVerticalComplianceState,
  setVerticalComplianceStateSource,
} from "@/modules/compliance/payoutGate";
import { releaseUnclaimedHolding } from "@/lib/server/unclaimedHolding";

import {
  aiModelLedgerScope,
  deprecateAiDatasetVersion,
  fileAiTrainingDispute,
  listFrozenAiModelIds,
  resolveAiTrainingDisputeVerified,
} from "../aiDisputes";
import { postAiLinesToHolding } from "../aiPosting";
import { writeAiLinesToMatchQueue } from "../aiQueue";
import { dispatchStatementProfile } from "../profiles";
import { loadFixture } from "./fixtures";
import { makeFakeSupabaseStore } from "./fakeSupabase";

const NOW = new Date("2026-09-30T12:00:00Z");
const MODEL_ID = "gpt-4o-ft-01";
const POOL_EVENT_ID = "pool-evt-2026-09"; // the attribution log's dataset version

/** The directive's default contract of record for the fixture's model. */
async function registerDefaultTerms(store: Store): Promise<void> {
  await store.upsertAiModelSplitTerms({
    ai_model_id: MODEL_ID,
    base_model_provider_fee_bps: 2000,
    developer_split_bps: 5000,
    contributor_pool_bps: 3000,
    base_model_provider_payee_id: "prov-foundation",
    base_model_provider_payee_name: "Foundation Provider",
    developer_payee_id: "dev-lora-creator",
    developer_payee_name: "LoRA Creator",
    model_operator_payee_id: "op-model-operator",
    model_operator_payee_name: "Model Operator",
  });
}

/** Parses + writes one AI fixture through the real profile and writer. */
async function ingestFixture(store: Store, fixture: string) {
  const profile = dispatchStatementProfile(loadFixture(fixture));
  if (profile === null) throw new Error(`fixture ${fixture} failed to dispatch`);
  const lines = profile.parse(loadFixture(fixture));
  const counts = await writeAiLinesToMatchQueue(store, lines);
  return { counts, outcomes: counts.lineOutcomes };
}

/**
 * The standard two-fixture setup: the attribution log (registry rows +
 * the training pool) and the billing log (the blended event). Posting
 * yields the model-scoped legs the freeze sweeps key on.
 */
async function setupPostedLegs(store: Store) {
  await registerDefaultTerms(store);
  const hf = await ingestFixture(store, "ai_huggingface_attribution.csv");
  const openai = await ingestFixture(store, "ai_openai_billing.csv");
  const posting = await postAiLinesToHolding(
    store,
    [...hf.counts.lineOutcomes, ...openai.counts.lineOutcomes],
    NOW,
  );
  return { hf, openai, posting };
}

/** A filed dispute of record — the rights holder's attribution claim. */
function disputeInput(overrides: Record<string, string> = {}) {
  return {
    ai_model_id: MODEL_ID,
    dataset_version: POOL_EVENT_ID,
    rights_holder_payee_id: "contrib-data-1",
    rights_holder_payee_name: "Data One",
    dispute_basis: "unauthorized use of the training dataset",
    ...overrides,
  };
}

/** The frozen legs' projection — status, cents, payee (parity-stable). */
async function holdProjection(store: Store) {
  const holds = await store.listUnauthorizedTrainingHolds(100);
  return holds
    .map((row) => ({
      status: row.status,
      amount_cents: row.amount_cents,
      payee_id: row.payee_id,
      split_run_id: row.split_run_id,
    }))
    .sort((a, b) =>
      a.amount_cents - b.amount_cents || a.payee_id.localeCompare(b.payee_id),
    );
}

/** The releasable holding legs' cent amounts, sorted. */
async function heldCents(store: Store): Promise<number[]> {
  return (await store.listUnclaimedHoldingCredits(100))
    .map((row) => row.amount_cents)
    .sort((a, b) => a - b);
}

describe("the UNAUTHORIZED_TRAINING_HOLD dispute freeze", () => {
  it("freezes the model's held legs on dispute filing — counted, honest, model-scoped", async () => {
    const store = new InMemoryStore();
    const { posting } = await setupPostedLegs(store);
    expect(posting.postedLegs).toBeGreaterThan(0);

    // Before the filing: only 'unclaimed_holding' legs exist.
    expect(await store.listUnauthorizedTrainingHolds(100)).toEqual([]);

    const filing = await fileAiTrainingDispute(store, disputeInput());
    expect(filing.ok).toBe(true);
    if (!filing.ok) throw new Error("unreachable");
    expect(filing.value.filed).toBe(true);
    expect(filing.value.model_ledger_scope).toBe(aiModelLedgerScope(MODEL_ID));
    // Every leg the sweep flipped is one that WAS still held — the count
    // equals the posted model-scoped legs, the honest report.
    expect(filing.value.frozen_legs).toBe(posting.postedLegs);

    // The frozen legs keep their amounts (money stays ON the ledger,
    // visibly) and the model's ingest scope (the queryable linkage).
    const frozen = await holdProjection(store);
    expect(frozen).toHaveLength(posting.postedLegs);
    for (const leg of frozen) {
      expect(leg.status).toBe("unauthorized_training_hold");
      expect(leg.split_run_id).toBe("ai:model:gpt-4o-ft-01");
      expect(Number.isInteger(leg.amount_cents)).toBe(true);
    }
    // The releasable listing is empty — every held leg of the model froze.
    expect(await heldCents(store)).toEqual([]);
  });

  it("never freezes voice-licensing legs — direct-to-actor routing is not pool money", async () => {
    const store = new InMemoryStore();
    const voice = await ingestFixture(
      store,
      "ai_elevenlabs_voice_licensing.csv",
    );
    await postAiLinesToHolding(store, voice.counts.lineOutcomes, NOW);
    // Voice legs carry NO model scope — a sweep over any model's ingest
    // scope cannot see them.
    const voiceLegs = (await store.listUnclaimedHoldingCredits(100)).map(
      (row) => row.split_run_id,
    );
    expect(voiceLegs.length).toBe(2);
    for (const scope of voiceLegs) expect(scope).not.toBe(aiModelLedgerScope(MODEL_ID));

    const filing = await fileAiTrainingDispute(store, disputeInput());
    expect(filing.ok).toBe(true);
    if (!filing.ok) throw new Error("unreachable");
    // Nothing model-scoped existed; the voice legs stay releasable.
    expect(filing.value.frozen_legs).toBe(0);
    expect((await heldCents(store)).length).toBe(2);
    expect(await holdProjection(store)).toEqual([]);
  });

  it("re-files the same claim as a counted no-op — the freeze never double-applies", async () => {
    const store = new InMemoryStore();
    const { posting } = await setupPostedLegs(store);

    const first = await fileAiTrainingDispute(store, disputeInput());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.filed).toBe(true);
    expect(first.value.frozen_legs).toBe(posting.postedLegs);

    const refiling = await fileAiTrainingDispute(store, disputeInput());
    expect(refiling.ok).toBe(true);
    if (!refiling.ok) throw new Error("unreachable");
    // The dispute of record converges; the sweep re-runs and flips
    // nothing (the CAS only flips still-held legs).
    expect(refiling.value.filed).toBe(false);
    expect(refiling.value.frozen_legs).toBe(0);
    expect(refiling.value.dispute.id).toBe(first.value.dispute.id);
    expect(await holdProjection(store)).toHaveLength(posting.postedLegs);
  });

  it("rejects a filing with blank fields (422) before touching the ledger", async () => {
    const store = new InMemoryStore();
    await setupPostedLegs(store);
    const filing = await fileAiTrainingDispute(
      store,
      disputeInput({ dispute_basis: "   " }),
    );
    expect(filing).toMatchObject({ ok: false, status: 422, code: "invalid_dispute_filing" });
    expect(await store.listUnauthorizedTrainingHolds(100)).toEqual([]);
  });

  it("listFrozenAiModelIds reflects the filed dispute — the posting pass's frozen set", async () => {
    const store = new InMemoryStore();
    expect(await listFrozenAiModelIds(store)).toEqual(new Set());
    const filing = await fileAiTrainingDispute(store, disputeInput());
    expect(filing.ok).toBe(true);
    expect(await listFrozenAiModelIds(store)).toEqual(new Set([MODEL_ID]));
  });
});

describe("thaw — only through the verified resolution path", () => {
  it("refuses to release a frozen leg (403) before any gate or split runs", async () => {
    const store = new InMemoryStore();
    await setupPostedLegs(store);
    const filing = await fileAiTrainingDispute(store, disputeInput());
    expect(filing.ok).toBe(true);
    const frozen = await store.listUnauthorizedTrainingHolds(100);

    const refused = await releaseUnclaimedHolding(store, {
      holding_ledger_id: frozen[0]!.id,
      splits: [
        { payee_id: "contrib-data-1", payee_name: "Data One", role: "creator", share_bps: 10_000 },
      ],
      operator_settlement_approved: true,
      vertical: "ai",
    }, NOW);
    expect(refused).toMatchObject({
      ok: false,
      status: 403,
      code: "unauthorized_training_hold",
    });
    // The refusal moved nothing and unfroze nothing.
    expect((await holdProjection(store))).toHaveLength(13);
  });

  it("resolves through the CAS — one winner, the concurrent loser reads 409", async () => {
    const store = new InMemoryStore();
    await setupPostedLegs(store);
    const filing = await fileAiTrainingDispute(store, disputeInput());
    expect(filing.ok).toBe(true);
    if (!filing.ok) throw new Error("unreachable");

    const winner = await resolveAiTrainingDisputeVerified(store, {
      dispute_id: filing.value.dispute.id,
      resolution_notes: "rights holder verified; license granted",
      resolved_by: "operator-on-call",
    }, NOW);
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw new Error("unreachable");
    expect(winner.value.dispute.status).toBe("resolved");
    expect(winner.value.dispute.resolved_by).toBe("operator-on-call");
    expect(winner.value.model_thawed).toBe(true);
    expect(winner.value.thawed_legs).toBe(13);

    const loser = await resolveAiTrainingDisputeVerified(store, {
      dispute_id: filing.value.dispute.id,
      resolution_notes: "too late",
      resolved_by: "operator-second",
    }, NOW);
    expect(loser).toMatchObject({
      ok: false,
      status: 409,
      code: "dispute_already_resolved",
    });
  });

  it("thaws the frozen legs back to releasable holding — and nothing else changes", async () => {
    const store = new InMemoryStore();
    await setupPostedLegs(store);
    const filing = await fileAiTrainingDispute(store, disputeInput());
    expect(filing.ok).toBe(true);

    const resolution = await resolveAiTrainingDisputeVerified(store, {
      dispute_id: filing.ok ? filing.value.dispute.id : "",
      resolution_notes: null,
      resolved_by: "operator-on-call",
    }, NOW);
    expect(resolution.ok).toBe(true);

    // Every frozen leg returned to 'unclaimed_holding' — same cents, same
    // rows, the status the ordinary clearance gate reads.
    expect(await holdProjection(store)).toEqual([]);
    const cents = await heldCents(store);
    expect(cents).toHaveLength(13);
    expect(Number.isInteger(cents.reduce((a, b) => a + b, 0))).toBe(true);
  });

  it("keeps the model frozen while a sibling dispute is active — the last resolution thaws", async () => {
    const store = new InMemoryStore();
    await setupPostedLegs(store);
    const first = await fileAiTrainingDispute(store, disputeInput());
    const second = await fileAiTrainingDispute(
      store,
      disputeInput({ rights_holder_payee_id: "contrib-voice-1", rights_holder_payee_name: "Voice Two" }),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) throw new Error("unreachable");

    // Resolving ONE of the two disputes thaws nothing — the model still
    // has an active dispute.
    const partial = await resolveAiTrainingDisputeVerified(store, {
      dispute_id: first.value.dispute.id,
      resolution_notes: "resolved for Data One",
      resolved_by: "operator-on-call",
    }, NOW);
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error("unreachable");
    expect(partial.value.model_thawed).toBe(false);
    expect(partial.value.thawed_legs).toBe(0);
    expect(await holdProjection(store)).toHaveLength(13);

    // The last active dispute's resolution is the model's exit.
    const final = await resolveAiTrainingDisputeVerified(store, {
      dispute_id: second.value.dispute.id,
      resolution_notes: "resolved for Voice Two",
      resolved_by: "operator-on-call",
    }, NOW);
    expect(final.ok).toBe(true);
    if (!final.ok) throw new Error("unreachable");
    expect(final.value.model_thawed).toBe(true);
    expect(final.value.thawed_legs).toBe(13);
    expect(await holdProjection(store)).toEqual([]);
  });

  it("returns 404 for an unknown dispute id", async () => {
    const store = new InMemoryStore();
    const resolution = await resolveAiTrainingDisputeVerified(store, {
      dispute_id: "no-such-dispute",
      resolution_notes: null,
      resolved_by: "operator-on-call",
    }, NOW);
    expect(resolution).toMatchObject({ ok: false, status: 404, code: "dispute_not_found" });
  });

  it("rejects a resolution with a blank resolver identity (422)", async () => {
    const store = new InMemoryStore();
    await setupPostedLegs(store);
    const filing = await fileAiTrainingDispute(store, disputeInput());
    expect(filing.ok).toBe(true);
    if (!filing.ok) throw new Error("unreachable");
    const resolution = await resolveAiTrainingDisputeVerified(store, {
      dispute_id: filing.value.dispute.id,
      resolution_notes: null,
      resolved_by: "  ",
    }, NOW);
    expect(resolution).toMatchObject({ ok: false, status: 422, code: "invalid_dispute_resolution" });
  });
});

describe("the dataset deprecation halt + clean archival", () => {
  it("halts a deprecated version's allocations into visible variance dust — conservation exact", async () => {
    const store = new InMemoryStore();
    await registerDefaultTerms(store);
    const hf = await ingestFixture(store, "ai_huggingface_attribution.csv");
    // The rights withdrawal lands BEFORE posting — the deprecation of
    // record exists, so the posting pass halts the pool.
    const deprecation = await deprecateAiDatasetVersion(store, {
      ai_model_id: MODEL_ID,
      dataset_version: POOL_EVENT_ID,
      reason: "rights_withdrawal",
      rights_holder_payee_id: null,
      rights_holder_payee_name: null,
      notes: "the whole dataset version is withdrawn",
    }, NOW);
    expect(deprecation.ok).toBe(true);
    if (!deprecation.ok) throw new Error("unreachable");
    // Nothing was archived — no ledger rows existed yet.
    expect(deprecation.value.created).toBe(true);
    expect(deprecation.value.archived).toEqual([]);

    const posting = await postAiLinesToHolding(store, hf.counts.lineOutcomes, NOW);
    // The $0.90 pool halts WHOLE (no payee named → every contributor's
    // share sweeps to the visible dust, never redistributed).
    expect(posting.poolRoyaltyMicros).toBe(0n);
    expect(posting.poolDustMicros).toBe(90_000_000n);
    // Conservation: Σ posted pool allocations (0) + dust (90¢) = the pool.
    const dustLegs = (await store.listUnclaimedHoldingCredits(100)).filter(
      (row) => row.amount_cents === 90,
    );
    expect(dustLegs).toHaveLength(1);
  });

  it("halts only the withdrawn payee's share — the untouched contributor still pays", async () => {
    const store = new InMemoryStore();
    await registerDefaultTerms(store);
    const hf = await ingestFixture(store, "ai_huggingface_attribution.csv");
    await deprecateAiDatasetVersion(store, {
      ai_model_id: MODEL_ID,
      dataset_version: POOL_EVENT_ID,
      reason: "rights_withdrawal",
      rights_holder_payee_id: "contrib-data-1",
      rights_holder_payee_name: "Data One",
      notes: "Data One withdrew their dataset",
    }, NOW);

    await postAiLinesToHolding(store, hf.counts.lineOutcomes, NOW);
    // The $0.90 pool over weights 3:1: Data One's share halts into the
    // dust leg (67¢ after the cent floor); Voice Two's 22¢ still posts.
    const cents = await heldCents(store);
    expect(cents).toEqual([22, 67]);
  });

  it("archives historical posted allocations WITHOUT touching the ledger rows", async () => {
    const store = new InMemoryStore();
    const { posting } = await setupPostedLegs(store);
    // The training pool posted its full 90¢ in micros (the two cent-
    // floored legs carry the sub-cent dust in their own micros).
    expect(posting.poolRoyaltyMicros).toBe(90_000_000n);
    const before = await heldCents(store);
    expect(before).toHaveLength(posting.postedLegs);

    const deprecation = await deprecateAiDatasetVersion(store, {
      ai_model_id: MODEL_ID,
      dataset_version: POOL_EVENT_ID,
      reason: "model_deprecation",
      rights_holder_payee_id: null,
      rights_holder_payee_name: null,
      notes: "model retired",
    }, NOW);
    expect(deprecation.ok).toBe(true);
    if (!deprecation.ok) throw new Error("unreachable");
    // The archive: every historical allocation of the version — the two
    // contributor legs — retired from active attribution (the HF pool had
    // no variance-dust leg: its micros dust lives inside the legs).
    expect(deprecation.value.archived).toHaveLength(2);
    const archivedAmounts = deprecation.value.archived
      .map((row) => row.amount_cents)
      .sort((a, b) => a - b);
    expect(archivedAmounts).toEqual([22, 67]);
    for (const row of deprecation.value.archived) {
      expect(row.currency).toBe("USD");
      expect(row.contributor_payee_id.length).toBeGreaterThan(0);
    }

    // THE APPEND-ONLY TRAIL IS INTACT — the archive retired the
    // attribution, not the ledger rows: same legs, same cents, same
    // statuses, nothing deleted.
    expect(await heldCents(store)).toEqual(before);
  });

  it("re-runs the deprecation as a converging no-op — never double-archives", async () => {
    const store = new InMemoryStore();
    await setupPostedLegs(store);
    const input = {
      ai_model_id: MODEL_ID,
      dataset_version: POOL_EVENT_ID,
      reason: "rights_withdrawal" as const,
      rights_holder_payee_id: null,
      rights_holder_payee_name: null,
      notes: null,
    };
    const first = await deprecateAiDatasetVersion(store, input, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.created).toBe(true);
    expect(first.value.archived).toHaveLength(2);

    const rerun = await deprecateAiDatasetVersion(store, input, NOW);
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) throw new Error("unreachable");
    // The deprecation of record converges; the archive sweep skips the
    // already-archived legs (the (deprecation_id, ledger_transaction_id)
    // UNIQUE — the idempotency the re-run depends on).
    expect(rerun.value.created).toBe(false);
    expect(rerun.value.deprecation.id).toBe(first.value.deprecation.id);
    expect(rerun.value.archived).toEqual([]);
  });
});

describe("the AI payout gate — consent and likeness states", () => {
  it("resolves the persisted states — absent maps to null, unknown maps to false", async () => {
    const store = new InMemoryStore();
    // ABSENT — no row for the payee: the gate sees null and refuses
    // (fail-closed when there is no record).
    expect(await resolveAiVerticalComplianceState(store, "contrib-data-1")).toBeNull();

    // UNKNOWN — a distinct stored state that still maps to false.
    await store.upsertAiPayoutGateState({
      payee_id: "contrib-data-1",
      ai_model_id: null,
      ai_training_consent_state: "unknown",
      synthetic_voice_likeness_state: "unknown",
      verified_by: "compliance-desk",
    });
    expect(await resolveAiVerticalComplianceState(store, "contrib-data-1")).toEqual({
      vertical: "ai",
      ai_training_consent_verified: false,
      synthetic_voice_likeness_released: false,
    });
  });

  it("fails closed through the pure verdict — unverified consent refuses first", async () => {
    const store = new InMemoryStore();
    await store.upsertAiPayoutGateState({
      payee_id: "contrib-data-1",
      ai_model_id: null,
      ai_training_consent_state: "unknown",
      synthetic_voice_likeness_state: "released",
      verified_by: "compliance-desk",
    });
    const state = await resolveAiVerticalComplianceState(store, "contrib-data-1");
    const verdict = evaluatePayoutCompliance({
      operatorSettlementApproved: true,
      kycStatus: "verified",
      verticalState: state,
    });
    expect(verdict).toMatchObject({ ok: false, code: "ai_training_consent_unverified" });
  });

  it("fails closed through the pure verdict — withheld likeness refuses", async () => {
    const store = new InMemoryStore();
    await store.upsertAiPayoutGateState({
      payee_id: "contrib-data-1",
      ai_model_id: null,
      ai_training_consent_state: "verified",
      synthetic_voice_likeness_state: "withheld",
      verified_by: "compliance-desk",
    });
    const state = await resolveAiVerticalComplianceState(store, "contrib-data-1");
    const verdict = evaluatePayoutCompliance({
      operatorSettlementApproved: true,
      kycStatus: "verified",
      verticalState: state,
    });
    expect(verdict).toMatchObject({ ok: false, code: "ai_voice_likeness_not_released" });
  });

  it("re-records a payee's states — the upsert converges on the newest state", async () => {
    const store = new InMemoryStore();
    const first = await store.upsertAiPayoutGateState({
      payee_id: "contrib-data-1",
      ai_model_id: MODEL_ID,
      ai_training_consent_state: "unknown",
      synthetic_voice_likeness_state: "unknown",
      verified_by: "compliance-desk",
    });
    const second = await store.upsertAiPayoutGateState({
      payee_id: "contrib-data-1",
      ai_model_id: MODEL_ID,
      ai_training_consent_state: "verified",
      synthetic_voice_likeness_state: "released",
      verified_by: "compliance-desk",
    });
    expect(second.id).toBe(first.id);
    const state = await resolveAiVerticalComplianceState(store, "contrib-data-1");
    expect(state).toEqual({
      vertical: "ai",
      ai_training_consent_verified: true,
      synthetic_voice_likeness_released: true,
    });
  });

  it("releases an AI holding end to end ONLY on verified consent + released likeness", async () => {
    const store = new InMemoryStore();
    await seedVerifiedAiParty(store, "contrib-data-1", "Data One");
    const credit = await postHoldingCredit(store, 5_000);

    // No gate state of record yet — the absent state refuses (fail-closed).
    const refused = await releaseUnclaimedHolding(store, {
      holding_ledger_id: credit.id,
      splits: [
        { payee_id: "contrib-data-1", payee_name: "Data One", role: "creator", share_bps: 10_000 },
      ],
      operator_settlement_approved: true,
      vertical: "ai",
    }, NOW);
    expect(refused).toMatchObject({ ok: false, status: 403, code: "vertical_state_unknown" });

    // Unknown consent also refuses.
    await store.upsertAiPayoutGateState({
      payee_id: "contrib-data-1",
      ai_model_id: null,
      ai_training_consent_state: "unknown",
      synthetic_voice_likeness_state: "unknown",
      verified_by: "compliance-desk",
    });
    const stillRefused = await releaseUnclaimedHolding(store, {
      holding_ledger_id: credit.id,
      splits: [
        { payee_id: "contrib-data-1", payee_name: "Data One", role: "creator", share_bps: 10_000 },
      ],
      operator_settlement_approved: true,
      vertical: "ai",
    }, NOW);
    expect(stillRefused).toMatchObject({
      ok: false,
      status: 403,
      code: "ai_training_consent_unverified",
    });

    // Verified consent but withheld likeness refuses.
    await store.upsertAiPayoutGateState({
      payee_id: "contrib-data-1",
      ai_model_id: null,
      ai_training_consent_state: "verified",
      synthetic_voice_likeness_state: "withheld",
      verified_by: "compliance-desk",
    });
    const likenessRefused = await releaseUnclaimedHolding(store, {
      holding_ledger_id: credit.id,
      splits: [
        { payee_id: "contrib-data-1", payee_name: "Data One", role: "creator", share_bps: 10_000 },
      ],
      operator_settlement_approved: true,
      vertical: "ai",
    }, NOW);
    expect(likenessRefused).toMatchObject({
      ok: false,
      status: 403,
      code: "ai_voice_likeness_not_released",
    });

    // The gate passes — the release runs the ordinary creator-credit
    // sequence (withholding, dust sweep, journal).
    await store.upsertAiPayoutGateState({
      payee_id: "contrib-data-1",
      ai_model_id: null,
      ai_training_consent_state: "verified",
      synthetic_voice_likeness_state: "released",
      verified_by: "compliance-desk",
    });
    const released = await releaseUnclaimedHolding(store, {
      holding_ledger_id: credit.id,
      splits: [
        { payee_id: "contrib-data-1", payee_name: "Data One", role: "creator", share_bps: 10_000 },
      ],
      operator_settlement_approved: true,
      vertical: "ai",
    }, NOW);
    expect(released.ok).toBe(true);
    if (!released.ok) throw new Error("unreachable");
    expect(released.value.party_credits[0]?.gross_cents).toBe(5_000);
    expect(released.value.holding_credit.status).toBe("settled");

    // The release CAS — a replayed release refuses with 409.
    const replay = await releaseUnclaimedHolding(store, {
      holding_ledger_id: credit.id,
      splits: [
        { payee_id: "contrib-data-1", payee_name: "Data One", role: "creator", share_bps: 10_000 },
      ],
      operator_settlement_approved: true,
      vertical: "ai",
    }, NOW);
    expect(replay).toMatchObject({ ok: false, status: 409, code: "holding_already_released" });
  });

  afterEach(() => {
    // The operations-seam override is process-global — reset it every test.
    setVerticalComplianceStateSource(null);
  });
});

describe("the locked Don ledger invariants", () => {
  it("allocations + dust equals gross INCLUDING the held bucket, integer cents everywhere", async () => {
    const store = new InMemoryStore();
    await setupPostedLegs(store);

    // Integer cents on every held leg — the ledger never carries a
    // fractional cent.
    const before = await heldCents(store);
    for (const cents of before) expect(Number.isInteger(cents)).toBe(true);

    // The freeze is a HELD BUCKET, not a disappearance: after filing,
    // frozen cents + still-held cents = the same total. Money moved
    // nowhere — the dispute only changed the status.
    const totalBefore = before.reduce((a, b) => a + b, 0);

    const filing = await fileAiTrainingDispute(store, disputeInput());
    expect(filing.ok).toBe(true);
    const frozen = await holdProjection(store);
    const frozenTotal = frozen.reduce((a, leg) => a + leg.amount_cents, 0);
    const heldAfter = (await heldCents(store)).reduce((a, b) => a + b, 0);

    expect(frozen).toHaveLength(13);
    expect(frozenTotal + heldAfter).toBe(totalBefore);
    for (const leg of frozen) expect(Number.isInteger(leg.amount_cents)).toBe(true);
  });
});

describe("store parity — the dispute scenario across the three backends", () => {
  const BACKENDS = [
    { name: "InMemoryStore", make: () => new InMemoryStore() },
    { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
    { name: "SupabaseStore", make: () => makeFakeSupabaseStore() },
  ] as const;

  for (const backend of BACKENDS) {
    it(`runs the full freeze → thaw → gate → deprecation scenario on ${backend.name}`, async () => {
      const store = backend.make();
      const { posting } = await setupPostedLegs(store);

      // 1. Freeze on filing.
      const filing = await fileAiTrainingDispute(store, disputeInput());
      expect(filing.ok).toBe(true);
      if (!filing.ok) throw new Error("unreachable");
      expect(filing.value.filed).toBe(true);
      expect(filing.value.frozen_legs).toBe(posting.postedLegs);
      expect(await holdProjection(store)).toHaveLength(posting.postedLegs);
      expect(await heldCents(store)).toEqual([]);

      // 2. The release path refuses while frozen.
      const frozen = await store.listUnauthorizedTrainingHolds(100);
      const refused = await releaseUnclaimedHolding(store, {
        holding_ledger_id: frozen[0]!.id,
        splits: [
          { payee_id: "contrib-data-1", payee_name: "Data One", role: "creator", share_bps: 10_000 },
        ],
        operator_settlement_approved: true,
        vertical: "ai",
      }, NOW);
      expect(refused).toMatchObject({ ok: false, status: 403, code: "unauthorized_training_hold" });

      // 3. Thaw through the verified resolution — exactly one CAS winner.
      const winner = await resolveAiTrainingDisputeVerified(store, {
        dispute_id: filing.value.dispute.id,
        resolution_notes: "rights verified",
        resolved_by: "operator-on-call",
      }, NOW);
      expect(winner.ok).toBe(true);
      if (!winner.ok) throw new Error("unreachable");
      expect(winner.value.thawed_legs).toBe(13);
      expect(winner.value.model_thawed).toBe(true);
      const loser = await resolveAiTrainingDisputeVerified(store, {
        dispute_id: filing.value.dispute.id,
        resolution_notes: "lost the race",
        resolved_by: "operator-second",
      }, NOW);
      expect(loser).toMatchObject({ ok: false, status: 409, code: "dispute_already_resolved" });

      // 4. The AI payout gate's persisted states — unknown refuses, the
      // verified+released upsert converges.
      await store.upsertAiPayoutGateState({
        payee_id: "contrib-data-1",
        ai_model_id: null,
        ai_training_consent_state: "unknown",
        synthetic_voice_likeness_state: "unknown",
        verified_by: "compliance-desk",
      });
      const unknownState = await resolveAiVerticalComplianceState(store, "contrib-data-1");
      expect(unknownState).toEqual({
        vertical: "ai",
        ai_training_consent_verified: false,
        synthetic_voice_likeness_released: false,
      });
      await store.upsertAiPayoutGateState({
        payee_id: "contrib-data-1",
        ai_model_id: null,
        ai_training_consent_state: "verified",
        synthetic_voice_likeness_state: "released",
        verified_by: "compliance-desk",
      });
      const verifiedState = await resolveAiVerticalComplianceState(store, "contrib-data-1");
      expect(verifiedState).toEqual({
        vertical: "ai",
        ai_training_consent_verified: true,
        synthetic_voice_likeness_released: true,
      });

      // 5. Deprecate the dataset version — the archives converge across
      // backends and a re-run is a no-op.
      const deprecation = await deprecateAiDatasetVersion(store, {
        ai_model_id: MODEL_ID,
        dataset_version: POOL_EVENT_ID,
        reason: "rights_withdrawal",
        rights_holder_payee_id: null,
        rights_holder_payee_name: null,
        notes: null,
      }, NOW);
      expect(deprecation.ok).toBe(true);
      if (!deprecation.ok) throw new Error("unreachable");
      expect(deprecation.value.created).toBe(true);
      const archivedAmounts = deprecation.value.archived
        .map((row) => row.amount_cents)
        .sort((a, b) => a - b);
      expect(archivedAmounts).toEqual([22, 67]);
      const rerun = await deprecateAiDatasetVersion(store, {
        ai_model_id: MODEL_ID,
        dataset_version: POOL_EVENT_ID,
        reason: "rights_withdrawal",
        rights_holder_payee_id: null,
        rights_holder_payee_name: null,
        notes: null,
      }, NOW);
      expect(rerun.ok).toBe(true);
      if (!rerun.ok) throw new Error("unreachable");
      expect(rerun.value.created).toBe(false);
      expect(rerun.value.archived).toEqual([]);

      // 6. The final ledger state — the append-only trail intact on every
      // backend: every leg back in holding, the model thawed.
      expect(await heldCents(store)).toHaveLength(posting.postedLegs);
      expect(await listFrozenAiModelIds(store)).toEqual(new Set());
    });
  }
});


/** Seeds the verified creator + platform vaults the release sequence needs. */
async function seedVerifiedAiParty(
  store: Store,
  payeeId: string,
  payeeName: string,
): Promise<void> {
  await store.upsertVault({
    payee_id: payeeId,
    payee_name: payeeName,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: NOW.toISOString(),
  });
  await store.upsertVault({
    payee_id: COMPANY_VARIANCE_PAYEE_ID,
    payee_name: COMPANY_VARIANCE_PAYEE_NAME,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: NOW.toISOString(),
  });
  await store.insertKycVerification({
    creator_id: payeeId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: NOW.toISOString(),
    verified_at: NOW.toISOString(),
  });
}

/** Posts one manual holding credit — the release tests' source of money. */
async function postHoldingCredit(store: Store, amountCents: number) {
  const posted = await store.insertLedgerTransaction({
    kind: "unclaimed_holding",
    status: "unclaimed_holding",
    payee_id: "platform-holding",
    payee_name: "Platform Holding",
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    split_run_id: "manual:test",
    line_item_id: "manual:test",
    settled_at: null,
    created_at: NOW.toISOString(),
  });
  return posted;
}

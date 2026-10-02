/**
 * AI lane tests (PR 24, founder AI directive + tokenization patch) — the
 * strict profile parses, the match_queue writer, and the nested split
 * posting pass, on the in-memory store over the checked-in fixtures.
 *
 * Pinned here — the brief's verifying tests, every micros value exact:
 *   • token and per-character/per-minute unit math, exact to the cent
 *     (the 1e-8 exact-decimal space, quantity × rate self-reconciled);
 *   • voice licensing routed DIRECTLY to the original voice actor of
 *     record (the row's payee cells are the routing; a sub-cent voice
 *     fee never posts);
 *   • the nested derivative split's ordered legs — fee off the top,
 *     fine-tuner and pool of the post-fee remainder, operator's exact
 *     complement — with the directive's default 2000/5000/3000 terms;
 *   • the blended attribution — total API token revenue × each
 *     contributor's recorded fractional weight, fail-closed against the
 *     nested split's contributor pool;
 *   • the pro-rata pool distribution by registered dataset token weight,
 *     floor residue swept visibly (never rounded up into a credit);
 *   • the whole-event holds (no terms of record; an unattributed event
 *     with an empty registry) — nothing posts, the queue rows stay the
 *     quarantine record;
 *   • replay idempotency end to end (counted no-ops) and the fail-closed
 *     ledger-error throw.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";

import { CanonicalPostingError } from "../posting";
import { postAiLinesToHolding } from "../aiPosting";
import { writeAiLinesToMatchQueue } from "../aiQueue";
import { dispatchStatementProfile } from "../profiles";
import {
  aiAttributionLegEventId,
  aiFeeLegEventId,
  aiVoiceLicensingEventId,
} from "../ai";
import { loadFixture } from "./fixtures";

const NOW = new Date("2026-09-30T12:00:00Z");

/** The directive's default contract of record for the fixture's model. */
async function registerDefaultTerms(
  store: Store,
  modelId = "gpt-4o-ft-01",
): Promise<void> {
  await store.upsertAiModelSplitTerms({
    ai_model_id: modelId,
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
  return { profile, counts, outcomes: counts.lineOutcomes };
}

/** Writes all four AI fixtures in registry order (attribution first). */
async function ingestAll(store: Store) {
  const hf = await ingestFixture(store, "ai_huggingface_attribution.csv");
  const openai = await ingestFixture(store, "ai_openai_billing.csv");
  const wandb = await ingestFixture(store, "ai_wandb_telemetry.csv");
  const voice = await ingestFixture(store, "ai_elevenlabs_voice_licensing.csv");
  return {
    outcomes: [
      ...hf.counts.lineOutcomes,
      ...openai.counts.lineOutcomes,
      ...wandb.counts.lineOutcomes,
      ...voice.counts.lineOutcomes,
    ],
    queueCounts: { hf: hf.counts, openai: openai.counts, wandb: wandb.counts, voice: voice.counts },
  };
}

describe("the strict profiles", () => {
  it("parses token math exactly — revenue reconciles to quantity × rate", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "ai_openai_billing.csv");
    expect(counts.written).toBe(3); // 1 unattributed + a blended event's 2 rows
    expect(counts.registryUpserts).toBe(0); // billing rows never touch the registry
    // Row 1: 1,000,000 tokens × $0.000005 = $5.00 (5e8 micros in the 1e-8 space).
    const row1 = counts.lineOutcomes[0]!;
    const detail1 = row1.line.aiDetail;
    expect(detail1?.kind).toBe("inference_billing");
    if (detail1?.kind !== "inference_billing") throw new Error("unreachable");
    expect(detail1.totalRevenueMicros).toBe("500000000");
    expect(detail1.usageUnit).toBe("tokens");
    expect(detail1.contributorPayeeId).toBe(null);
    // Row 2: 2,000,000 tokens × $0.000002 = $4.00 with a 0.10 blended weight.
    const row2 = counts.lineOutcomes[1]!;
    const detail2 = row2.line.aiDetail;
    if (detail2?.kind !== "inference_billing") throw new Error("unreachable");
    expect(detail2.totalRevenueMicros).toBe("400000000");
    expect(detail2.contributorPayeeId).toBe("contrib-data-1");
    expect(detail2.datasetAttributionWeight).toBe("0.10");
  });

  it("prices per-character and per-minute voice rows and refuses token-priced ones", () => {
    const voice = dispatchStatementProfile(
      loadFixture("ai_elevenlabs_voice_licensing.csv"),
    );
    if (voice === null) throw new Error("voice fixture failed to dispatch");
    const lines = voice.parse(loadFixture("ai_elevenlabs_voice_licensing.csv"));
    expect(lines).toHaveLength(3);
    // 350,000 characters × $0.00002 = $7.00 (7e8 micros) — per character.
    const perCharacter = lines[0]!.aiDetail;
    if (perCharacter?.kind !== "voice_licensing") throw new Error("unreachable");
    expect(perCharacter.usageUnit).toBe("characters");
    expect(perCharacter.ratePerUnitMicros).toBe("2000"); // $0.00002 in 1e-8 micros
    // 20 minutes × $0.005 = $0.10 (1e7 micros) — per minute.
    const perMinute = lines[2]!.aiDetail;
    if (perMinute?.kind !== "voice_licensing") throw new Error("unreachable");
    expect(perMinute.usageUnit).toBe("minutes");
    expect(perMinute.ratePerUnitMicros).toBe("500000");
    // A token-priced synthetic-voice row is a hostile licensing deal.
    const tokenPriced =
      "Event ID,Voice ID,Model ID,Voice Actor Payee ID,Voice Actor Payee Name,Usage Unit,Usage Quantity,Rate Per Unit,Currency,Date\n" +
      "voice-evt-009,voice-mara-7,eleven-turbo-v2,actor-mara-9,Mara Velez,tokens,100,0.00002,USD,2026-09-18\n";
    expect(() => voice.parse(tokenPriced)).toThrow(/invalid_voice_usage_unit/);
  });

  it("rejects a billing row whose revenue does not reconcile exactly", () => {
    const openai = dispatchStatementProfile(loadFixture("ai_openai_billing.csv"));
    if (openai === null) throw new Error("openai fixture failed to dispatch");
    const hostile =
      "Event ID,Model ID,Usage Unit,Usage Quantity,Rate Per Unit,Total Revenue,Contributor Payee ID,Contributor Payee Name,Dataset Attribution Weight,Currency,Date\n" +
      "evt-bad-001,gpt-4o-ft-01,tokens,1000000,0.000005,5.01,,,,USD,2026-09-15\n";
    expect(() => openai.parse(hostile)).toThrow(
      /revenue_reconciliation_mismatch/,
    );
  });

  it("rejects partial contributor cells and partial pool cells", () => {
    const openai = dispatchStatementProfile(loadFixture("ai_openai_billing.csv"));
    if (openai === null) throw new Error("openai fixture failed to dispatch");
    const partialContributor =
      "Event ID,Model ID,Usage Unit,Usage Quantity,Rate Per Unit,Total Revenue,Contributor Payee ID,Contributor Payee Name,Dataset Attribution Weight,Currency,Date\n" +
      "evt-part-001,gpt-4o-ft-01,tokens,1000,0.000005,0.005,contrib-data-1,,0.10,USD,2026-09-15\n";
    expect(() => openai.parse(partialContributor)).toThrow(
      /partial_contributor_cells/,
    );
    const hf = dispatchStatementProfile(
      loadFixture("ai_huggingface_attribution.csv"),
    );
    if (hf === null) throw new Error("hf fixture failed to dispatch");
    const partialPool =
      "Model ID,Attribution Event ID,Contributor Payee ID,Contributor Payee Name,Contributor Class,Dataset Token Weight,Pool Event ID,Data Pool Royalty,Currency,Date\n" +
      "gpt-4o-ft-01,attr-2026-09-a,contrib-data-1,Data One,dataset,3,pool-evt-2026-09,,USD,2026-09-19\n";
    expect(() => hf.parse(partialPool)).toThrow(/partial_pool_cells/);
  });
});

describe("the queue writer", () => {
  it("upserts the registry facts from the attribution log", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "ai_huggingface_attribution.csv");
    expect(counts.written).toBe(2);
    expect(counts.registryUpserts).toBe(2);
    const contributions = await store.listAiModelContributions("gpt-4o-ft-01");
    expect(contributions).toHaveLength(2);
    expect(contributions.map((c) => c.contributor_payee_id).sort()).toEqual([
      "contrib-data-1",
      "contrib-voice-1",
    ]);
    const dataRecord = contributions.find(
      (c) => c.contributor_payee_id === "contrib-data-1",
    );
    expect(dataRecord?.contributor_class).toBe("dataset");
    expect(dataRecord?.dataset_token_weight).toBe("3");
  });

  it("replays a re-shipped log as counted no-ops", async () => {
    const store = new InMemoryStore();
    await ingestFixture(store, "ai_openai_billing.csv");
    const { counts: replay } = await ingestFixture(store, "ai_openai_billing.csv");
    expect(replay.written).toBe(0);
    expect(replay.alreadyPresent).toBe(3);
  });
});

describe("the nested split posting pass", () => {
  it("posts the nested split's ordered legs exactly — fee, fine-tuner, operator", async () => {
    const store = new InMemoryStore();
    await registerDefaultTerms(store);
    const { outcomes } = await ingestFixture(store, "ai_openai_billing.csv");
    const posting = await postAiLinesToHolding(store, outcomes, NOW);
    // The $4.00 blended event (directive defaults 20%/50%/30% of the
    // post-fee remainder): fee $0.80, fine-tuner $1.60, operator's exact
    // complement $0.64. The unattributed $5.00 sibling HOLDS whole — the
    // registry has no contributions in this test — so nothing posts for it.
    expect(posting.feeMicros).toBe(80_000_000n); // $0.80
    expect(posting.developerMicros).toBe(160_000_000n); // $1.60
    expect(posting.operatorMicros).toBe(64_000_000n); // $0.64
    expect(posting.heldUnattributedEvents).toBe(1);
    // The fee leg of the blended event, by its own content-derived id.
    const credits = await store.listUnclaimedHoldingCredits(100);
    const feeLeg = credits.find(
      (c) =>
        c.line_item_id ===
        aiFeeLegEventId("openai_llm_billing_log_csv", "gpt-4o-ft-01", "evt-blend-002"),
    );
    expect(feeLeg?.amount_cents).toBe(80);
  });

  it("multiplies TOTAL token revenue by each blended weight, fail-closed to the pool", async () => {
    const store = new InMemoryStore();
    await registerDefaultTerms(store);
    const hf = await ingestFixture(store, "ai_huggingface_attribution.csv");
    const openai = await ingestFixture(store, "ai_openai_billing.csv");
    const posting = await postAiLinesToHolding(
      store,
      [...hf.counts.lineOutcomes, ...openai.counts.lineOutcomes],
      NOW,
    );
    // The blended event's legs: $4.00 × 0.10 = $0.40 and $4.00 × 0.05 =
    // $0.20; the nested pool is $0.96, so the unattributed $0.36 residue
    // sweeps visibly as dust — conservation holds by construction.
    expect(posting.attributionMicros).toBe(180_000_000n); // $0.60 blended + $1.20 registry
    expect(posting.poolDustMicros).toBe(36_000_000n); // $0.36
    const credits = await store.listUnclaimedHoldingCredits(100);
    const dataLeg = credits.find(
      (c) =>
        c.line_item_id ===
        aiAttributionLegEventId(
          "openai_llm_billing_log_csv",
          "gpt-4o-ft-01",
          "evt-blend-002",
          "contrib-data-1",
        ),
    );
    expect(dataLeg?.amount_cents).toBe(40);
  });

  it("distributes an unattributed event's pool pro-rata by registered weight", async () => {
    const store = new InMemoryStore();
    await registerDefaultTerms(store);
    const hf = await ingestFixture(store, "ai_huggingface_attribution.csv");
    const openai = await ingestFixture(store, "ai_openai_billing.csv");
    const posting = await postAiLinesToHolding(
      store,
      [...hf.counts.lineOutcomes, ...openai.counts.lineOutcomes],
      NOW,
    );
    // The $5.00 event's registry pool is $1.20; weights 3:1 split it
    // $0.90 / $0.30 exactly, no dust.
    const credits = await store.listUnclaimedHoldingCredits(100);
    const dataLeg = credits.find(
      (c) =>
        c.line_item_id ===
        aiAttributionLegEventId(
          "openai_llm_billing_log_csv",
          "gpt-4o-ft-01",
          "evt-unattr-001",
          "contrib-data-1",
        ),
    );
    const voiceLeg = credits.find(
      (c) =>
        c.line_item_id ===
        aiAttributionLegEventId(
          "openai_llm_billing_log_csv",
          "gpt-4o-ft-01",
          "evt-unattr-001",
          "contrib-voice-1",
        ),
    );
    expect(dataLeg?.amount_cents).toBe(90);
    expect(voiceLeg?.amount_cents).toBe(30);
    expect(posting.heldUnattributedEvents).toBe(0);
  });

  it("routes voice licensing DIRECTLY to the actor of record — sub-cent never posts", async () => {
    const store = new InMemoryStore();
    const { outcomes } = await ingestFixture(
      store,
      "ai_elevenlabs_voice_licensing.csv",
    );
    const posting = await postAiLinesToHolding(store, outcomes, NOW);
    // $7.00 + $0.10 post; the $0.005 minute row stays in its queue row.
    expect(posting.voiceLicensingMicros).toBe(710_500_000n);
    expect(posting.zeroNetLegs).toBe(1);
    expect(posting.postedLegs).toBe(2);
    const credits = await store.listUnclaimedHoldingCredits(100);
    const actorLeg = credits.find(
      (c) =>
        c.line_item_id ===
        aiVoiceLicensingEventId(
          "elevenlabs_voice_clone_licensing_csv",
          "voice-mara-7",
          "voice-evt-001",
        ),
    );
    expect(actorLeg?.amount_cents).toBe(700);
  });

  it("distributes the training pool pro-rata by dataset token weight", async () => {
    const store = new InMemoryStore();
    const { outcomes } = await ingestFixture(
      store,
      "ai_huggingface_attribution.csv",
    );
    const posting = await postAiLinesToHolding(store, outcomes, NOW);
    // The file's $0.90 pool over weights 3:1: $0.675 and $0.225 — each
    // leg floors to whole cents (67¢, 22¢), the micros dust never rounds up.
    expect(posting.poolRoyaltyMicros).toBe(90_000_000n);
    expect(posting.poolDustMicros).toBe(0n);
    expect(posting.postedLegs).toBe(2);
    const credits = await store.listUnclaimedHoldingCredits(100);
    const amounts = credits
      .filter((c) => c.line_item_id.startsWith("ai:pool:"))
      .map((c) => c.amount_cents)
      .sort((a, b) => a - b);
    expect(amounts).toEqual([22, 67]);
  });

  it("holds the whole event when the model has no contract terms of record", async () => {
    const store = new InMemoryStore();
    const { outcomes } = await ingestFixture(store, "ai_wandb_telemetry.csv");
    const posting = await postAiLinesToHolding(store, outcomes, NOW);
    // run-held-01's model is unpriced — nothing posts for it. (The fixture's
    // second event also holds: the registry has no contributions yet.)
    expect(posting.heldUnattributedEvents).toBe(2);
    expect(posting.postedLegs).toBe(0);
  });

  it("holds an unattributed event when the registry resolves to no contributors", async () => {
    const store = new InMemoryStore();
    await registerDefaultTerms(store, "gpt-empty-registry");
    const empty =
      "Run ID,Model ID,Usage Unit,Usage Quantity,Rate Per Unit,Total Revenue,Contributor Payee ID,Contributor Payee Name,Dataset Attribution Weight,Currency,Date\n" +
      "run-empty-01,gpt-empty-registry,tokens,100,0.000001,0.0001,,,,USD,2026-09-17\n";
    const profile = dispatchStatementProfile(empty);
    if (profile === null) throw new Error("fixture failed to dispatch");
    const counts = await writeAiLinesToMatchQueue(store, profile.parse(empty));
    const posting = await postAiLinesToHolding(store, counts.lineOutcomes, NOW);
    expect(posting.heldUnattributedEvents).toBe(1);
    expect(posting.postedLegs).toBe(0);
  });

  it("fails closed when blended weights dilute the provider fee or developer split", async () => {
    const store = new InMemoryStore();
    await registerDefaultTerms(store);
    const hostile =
      "Event ID,Model ID,Usage Unit,Usage Quantity,Rate Per Unit,Total Revenue,Contributor Payee ID,Contributor Payee Name,Dataset Attribution Weight,Currency,Date\n" +
      "evt-greedy-001,gpt-4o-ft-01,tokens,1000000,0.000005,5.00,contrib-data-1,Data One,0.50,USD,2026-09-15\n";
    const profile = dispatchStatementProfile(hostile);
    if (profile === null) throw new Error("fixture failed to dispatch");
    const counts = await writeAiLinesToMatchQueue(store, profile.parse(hostile));
    // $2.50 of blended attribution against a $1.20 pool — the job fails
    // loudly; nothing posts.
    await expect(
      postAiLinesToHolding(store, counts.lineOutcomes, NOW),
    ).rejects.toThrow(/ai_blended_attribution_exceeds_pool/);
    expect((await store.listUnclaimedHoldingCredits(100)).length).toBe(0);
  });

  it("replays as counted no-ops — a retried pass never double-posts", async () => {
    const store = new InMemoryStore();
    await registerDefaultTerms(store);
    const { outcomes } = await ingestAll(store);
    const first = await postAiLinesToHolding(store, outcomes, NOW);
    const second = await postAiLinesToHolding(store, outcomes, NOW);
    expect(second.postedLegs).toBe(0);
    expect(second.replayedLegs).toBe(first.postedLegs);
    expect((await store.listUnclaimedHoldingCredits(100)).length).toBe(
      first.postedLegs,
    );
  });

  it("fails closed when the ledger store throws — the queue rows stay the record", async () => {
    const store = new InMemoryStore();
    await registerDefaultTerms(store);
    const { outcomes } = await ingestFixture(
      store,
      "ai_elevenlabs_voice_licensing.csv",
    );
    const broken: Store = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "insertLedgerTransaction") {
          return async () => {
            throw new Error("ledger store offline");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(postAiLinesToHolding(broken, outcomes, NOW)).rejects.toThrow(
      CanonicalPostingError,
    );
  });

  it("conserves every micro across the whole pass", async () => {
    const store = new InMemoryStore();
    await registerDefaultTerms(store);
    const { outcomes } = await ingestAll(store);
    const posting = await postAiLinesToHolding(store, outcomes, NOW);
    // Gross: OpenAI $9.00 + W&B same-id event $5.00 (its $0.50 sibling
    // holds) + voice $7.105 + training pool $0.90 = $22.005.
    const total =
      posting.feeMicros +
      posting.developerMicros +
      posting.operatorMicros +
      posting.attributionMicros +
      posting.voiceLicensingMicros +
      posting.poolRoyaltyMicros +
      posting.poolDustMicros;
    expect(total).toBe(2_200_500_000n);
  });
});

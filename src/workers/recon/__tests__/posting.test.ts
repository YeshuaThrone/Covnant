/**
 * Canonical posting seam tests — the ACTIVATED PR 2 → PR 7 wiring.
 *
 * Two layers:
 * - pure unit tests for the seam's conversion and postability rules;
 * - worker E2E over the REAL store backends (InMemoryStore, SqliteStore on
 *   :memory:) and the REAL checked-in fixtures: a matched master line's
 *   gross posts to UNCLAIMED_HOLDING in whole integer cents, a reprocessed
 *   ingest reads PR 7's per-source replay guard as counted no-ops, a
 *   posting failure quarantines the match and fails the job (a retry heals
 *   idempotently — never a drop, never a double post), and the standing
 *   payout gates still stand between a worker-posted credit and any payout.
 *
 * The release-path internals (CAS, splits, withholding, recoupment, dust)
 * are PR 7's locked surface under its own suite — those tests run on the
 * InMemoryStore only, per that precedent; everything POSTING-side here
 * runs on both backends.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import { sumHeldCents, listRecoveryCandidates, releaseUnclaimedHolding } from "@/lib/server/unclaimedHolding";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import { UNCLAIMED_HOLDING_PAYEE_ID, UNCLAIMED_HOLDING_PAYEE_NAME } from "@/modules/don/constants";
import type { VaultAssetRecord } from "@/lib/covnant/vault";
import type { ParsedStatementLine } from "../records";
import { microsToWholeCents, isPostableLine } from "../posting";
import { runOnce } from "../worker";
import type { VaultLookup } from "../matchQueue";

import { loadFixture } from "./fixtures";

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
] as const;

const NOW = () => new Date("2026-09-30T12:00:00Z");

/** Seeds one statement ingest and its recon job; returns the ids. */
async function seedJob(
  store: Store,
  fileName: string,
  content: string,
): Promise<{ jobId: string; ingestId: string }> {
  const ingest = await store.insertStatementIngest({
    format: "csv_statement",
    source: "statement",
    file_name: fileName,
    content,
    status: "parsed",
    event_count: null,
    error: null,
    created_at: NOW().toISOString(),
  });
  const job = await store.createReconJob({ source: "statement", ingest_id: ingest.id });
  return { jobId: job.id, ingestId: ingest.id };
}

/** A vault stub whose ISRCs resolve — both spellings the fixture carries. */
function vaultWithIsrc(): VaultLookup {
  return {
    async findByIdentifier(kind, value): Promise<VaultAssetRecord | null> {
      if (
        kind === "ISRC" &&
        (value === "US-XYT-26-00001" || value === "USXYT2600001")
      ) {
        return {
          cvtCode: "CVT-TEST-TRACK",
          cbtCode: "CBT-MUS-TESTTRACK",
          title: "Neon Skyline",
          medium: "music",
          externalIdentifiers: { ISRC: value },
          holderUct: null,
        };
      }
      return null;
    },
  };
}

const queueRowsFor = async (store: Store, ingestId: string) =>
  (await store.listMatchQueueEntries(undefined, 500)).filter((row) =>
    row.event_id.startsWith(`recon:${ingestId}:`),
  );

// ---------------------------------------------------------------------------
// Pure seam rules.
// ---------------------------------------------------------------------------

describe("microsToWholeCents — the exact 1e-8 micros → integer cents conversion", () => {
  it("converts whole cents exactly", () => {
    expect(microsToWholeCents(431_000_000n)).toBe(431);
    expect(microsToWholeCents(140_000_000n)).toBe(140);
    expect(microsToWholeCents(1_000_000n)).toBe(1);
  });

  it("floors sub-cent residue — never rounds up into invented money", () => {
    expect(microsToWholeCents(400_000n)).toBe(0); // $0.004
    expect(microsToWholeCents(999_999n)).toBe(0);
    expect(microsToWholeCents(1n)).toBe(0);
    expect(microsToWholeCents(431_999_999n)).toBe(431);
  });

  it("refuses values outside the safe integer-cent range", () => {
    expect(() => microsToWholeCents(2n ** 53n * 1_000_000n)).toThrow(/overflow/);
  });
});

describe("isPostableLine — the seam's subject rule", () => {
  const matched = (overrides: Partial<ParsedStatementLine> = {}): ParsedStatementLine => ({
    lineNumber: 1,
    profile: "distrokid_csv",
    rightsType: "master",
    statementSourceType: null,
    tierLevel: null,
    rightsPipeline: "master_digital_performance",
    period: "2026-08",
    currency: "USD",
    grossMicros: 431_000_000n,
    isAdjustment: false,
    identifiers: { ISRC: "US-XYT-26-00001" },
    workTitle: "Neon Skyline",
    territory: "US",
    platform: "Spotify",
    usageNote: "",
    raw: ["raw"],
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    ...overrides,
  });

  it("posts a matched positive music line", () => {
    expect(isPostableLine(matched(), "CBT-MUS-TESTTRACK")).toBe(true);
    expect(isPostableLine(matched({ rightsType: "publishing" }), "CBT-PUB-X")).toBe(true);
  });

  it("never posts unmatched, quarantined-rights, adjustment, or non-positive lines", () => {
    expect(isPostableLine(matched(), null)).toBe(false); // no verified track
    expect(isPostableLine(matched({ rightsType: "unknown" }), "CBT-FLM-X")).toBe(false); // film lane
    expect(isPostableLine(matched({ isAdjustment: true }), "CBT-X")).toBe(false);
    expect(isPostableLine(matched({ grossMicros: 0n }), "CBT-X")).toBe(false);
    expect(isPostableLine(matched({ grossMicros: -5_000_000n }), "CBT-X")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker E2E — the posting path over the real backends.
// ---------------------------------------------------------------------------

describe.each(BACKENDS)("$name — canonical posting seam", ({ make }) => {
  it("posts matched master lines to holding: sentinel payee, integer cents, open queue rows, recovery pairing", async () => {
    const store = make();
    const { ingestId } = await seedJob(store, "distrokid.csv", loadFixture("distrokid.csv"));

    const processed = await runOnce({ store, vault: vaultWithIsrc(), now: NOW });
    expect(processed?.outcome).toBe("completed");
    expect(processed?.job.result).toEqual({
      events_written: 2,
      matched: 2,
      unmatched: 0,
      engine_used: null,
      holding_posted: 2,
      holding_replayed: 0,
    });

    // The held credits: one per matched line, sentinel payee, exact cents.
    const held = await store.listUnclaimedHoldingCredits(100);
    expect(held).toHaveLength(2);
    const byLineItem = new Map(held.map((row) => [row.line_item_id, row]));
    const line1 = byLineItem.get(`recon:${ingestId}:line:1`);
    const line2 = byLineItem.get(`recon:${ingestId}:line:2`);
    expect(line1?.amount_cents).toBe(431); // $4.31 exact
    expect(line2?.amount_cents).toBe(140); // $1.40 exact
    for (const credit of held) {
      expect(credit.payee_id).toBe(UNCLAIMED_HOLDING_PAYEE_ID);
      expect(credit.payee_name).toBe(UNCLAIMED_HOLDING_PAYEE_NAME);
      expect(credit.kind).toBe("unclaimed_holding");
      expect(credit.status).toBe("unclaimed_holding");
      expect(Number.isSafeInteger(credit.amount_cents)).toBe(true);
    }

    // The GL journal per source id — the replay guard's marker.
    for (const eventId of [`recon:${ingestId}:line:1`, `recon:${ingestId}:line:2`]) {
      const journals = await store.listGlJournalsByRef("match_queue", eventId);
      expect(journals).toHaveLength(1);
      expect(journals[0].kind).toBe("unclaimed_holding_post");
    }

    // The queue rows stay open — the quarantine record and the recovery
    // pairing's vocabulary; posting does not resolve them.
    const rows = await queueRowsFor(store, ingestId);
    expect(rows.every((row) => row.status === "open")).toBe(true);
    expect(rows.every((row) => row.matched_cbt_code === "CBT-MUS-TESTTRACK")).toBe(true);

    // The recovery discovery pairs each open event with its exact credit.
    const report = await listRecoveryCandidates(store, 200);
    const paired = report.candidates.filter((c) => c.event.event_id.startsWith(`recon:${ingestId}:`));
    expect(paired.map((c) => c.held_cents).sort((a, b) => a - b)).toEqual([140, 431]);
    expect(sumHeldCents(held)).toBe(571); // the exact gross, integer cents
  });

  it("re-processes the ingest through the per-source replay guard — counted no-ops, zero new credits", async () => {
    const store = make();
    const { ingestId } = await seedJob(store, "distrokid.csv", loadFixture("distrokid.csv"));

    await runOnce({ store, vault: vaultWithIsrc(), now: NOW });
    const creditsBefore = await store.listUnclaimedHoldingCredits(100);
    expect(creditsBefore).toHaveLength(2);

    await store.createReconJob({ source: "statement", ingest_id: ingestId });
    const replay = await runOnce({ store, vault: vaultWithIsrc(), now: NOW });
    expect(replay?.outcome).toBe("completed");
    expect(replay?.job.result).toEqual({
      events_written: 0, // rows already present — the replay wrote nothing
      matched: 0,
      unmatched: 0,
      engine_used: null,
      holding_posted: 0,
      holding_replayed: 2, // both posts read PR 7's 409 journal-ref guard
    });

    const creditsAfter = await store.listUnclaimedHoldingCredits(100);
    expect(creditsAfter).toHaveLength(2); // never a double post
    expect(creditsAfter.map((c) => c.id).sort()).toEqual(creditsBefore.map((c) => c.id).sort());
    expect(sumHeldCents(creditsAfter)).toBe(571);
  });

  it("a posting failure quarantines the match and fails the job; a retry heals idempotently", async () => {
    const store = make();
    const { ingestId } = await seedJob(store, "distrokid.csv", loadFixture("distrokid.csv"));
    const doomedEvent = `recon:${ingestId}:line:2`;

    const realInsert = store.insertLedgerTransaction.bind(store);
    const fault = vi.spyOn(store, "insertLedgerTransaction").mockImplementation(async (row) => {
      if (row.kind === "unclaimed_holding" && row.line_item_id === doomedEvent) {
        throw new Error("post ledger unavailable (test fault)");
      }
      return realInsert(row);
    });

    const failedPass = await runOnce({ store, vault: vaultWithIsrc(), now: NOW });
    expect(failedPass?.outcome).toBe("failed");
    expect(failedPass?.job.status).toBe("pending"); // re-pooled under the retry budget
    expect(failedPass?.job.error).toMatch(new RegExp(`unclaimed_holding_post_failed.*${doomedEvent}`));

    // NEVER A DROP: both queue rows are durable — the failed line's match
    // sits quarantined (open) exactly like its successful sibling.
    const rows = await queueRowsFor(store, ingestId);
    expect(rows.map((row) => row.event_id).sort()).toEqual([
      `recon:${ingestId}:line:1`,
      `recon:${ingestId}:line:2`,
    ]);
    // Line 1 posted before the fault and stays honestly posted (no rollback
    // theater); the doomed line has NO credit.
    expect((await store.listUnclaimedHoldingCredits(100)).map((c) => c.line_item_id)).toEqual([
      `recon:${ingestId}:line:1`,
    ]);
    expect(await store.listGlJournalsByRef("match_queue", doomedEvent)).toHaveLength(0);
    fault.mockRestore();

    // The retry: the same job re-claimed; the write replays as no-ops and
    // the posts heal — line 1 via the replay guard, line 2 freshly.
    const healed = await runOnce({ store, vault: vaultWithIsrc(), now: NOW });
    expect(healed?.outcome).toBe("completed");
    expect(healed?.job.result).toEqual({
      events_written: 0,
      matched: 0,
      unmatched: 0,
      engine_used: null,
      holding_posted: 1,
      holding_replayed: 1,
    });
    const credits = await store.listUnclaimedHoldingCredits(100);
    expect(credits).toHaveLength(2); // exactly one credit per line — no double post
    expect(sumHeldCents(credits)).toBe(571);
  });

  it("a sub-cent matched line stays quarantined — integer cents or nothing, never rounded up", async () => {
    const store = make();
    const subCent = [
      "Sale Date,Store,Artist,Title,ISRC,UPC,Country Of Sale,Quantity,Unit Price,Currency,Net Earnings,Reporting Period",
      "2026-08-31,Spotify,Yeshua Throne,Neon Skyline,US-XYT-26-00001,001234567890,US,1,$0.0034,USD,$0.004,2026-08",
    ].join("\n");
    const { ingestId } = await seedJob(store, "distrokid.csv", subCent);

    const processed = await runOnce({ store, vault: vaultWithIsrc(), now: NOW });
    expect(processed?.outcome).toBe("completed");
    expect(processed?.job.result?.holding_posted).toBe(0);

    // No ledger row, no journal — and the match row keeps the exact micros.
    expect(await store.listUnclaimedHoldingCredits(100)).toHaveLength(0);
    const rows = await queueRowsFor(store, ingestId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open");
    expect(rows[0].matched_cbt_code).toBe("CBT-MUS-TESTTRACK");
    expect(rows[0].gross_micros).toBe("400000");
  });

  it("film ingests post nothing — rights-'unknown' money belongs to the waterfall lane", async () => {
    const store = make();
    await seedJob(store, "film_vod.csv", loadFixture("film_vod.csv"));

    const processed = await runOnce({
      store,
      vault: {
        async findByIdentifier(kind, value) {
          if (kind === "EIDR" && value === "10.5240/000A-000B-000C-000D-000E-F") {
            return {
              cvtCode: "CVT-TEST-FILM",
              cbtCode: "CBT-FLM-TESTFILM",
              title: "Midnight Reel",
              medium: "film",
              externalIdentifiers: { EIDR: value },
              holderUct: null,
            };
          }
          return null;
        },
      },
      now: NOW,
    });
    expect(processed?.outcome).toBe("completed");
    expect(processed?.job.result?.holding_posted).toBe(0);
    expect(await store.listUnclaimedHoldingCredits(100)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The standing payout gates — release-path tests on InMemoryStore, per PR 7's
// precedent for release internals.
// ---------------------------------------------------------------------------

describe("the activated seam vs the standing payout gates", () => {
  afterEach(() => {
    // The vertical-state override is process-global — reset every test.
    setVerticalComplianceStateSource(null);
  });

  it("a worker-posted credit releases ONLY through the clearance-gated path — KYC and vertical state fail closed", async () => {
    const store = new InMemoryStore();
    const { ingestId } = await seedJob(store, "distrokid.csv", loadFixture("distrokid.csv"));
    await runOnce({ store, vault: vaultWithIsrc(), now: NOW });

    const held = await store.listUnclaimedHoldingCredits(100);
    const credit = held.find((c) => c.line_item_id === `recon:${ingestId}:line:1`);
    expect(credit).toBeDefined();

    // Gate 1 — no KYC record: unknown refuses, never assumed verified.
    const kycRefusal = await releaseUnclaimedHolding(
      store,
      {
        holding_ledger_id: credit!.id,
        splits: [{ payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 }],
        operator_settlement_approved: true,
        vertical: "music",
      },
      NOW(),
    );
    expect(kycRefusal).toMatchObject({ ok: false, status: 403, code: "kyc_state_unknown" });

    // Gate 2 — KYC verified but no vertical compliance state: unknown refuses.
    await store.upsertVault({
      payee_id: "creator_1",
      payee_name: "Creator One",
      available_balance: 0,
      pending_balance: 0,
      reserve_balance: 0,
      updated_at: NOW().toISOString(),
    });
    await store.insertKycVerification({
      creator_id: "creator_1",
      plaid_link_token: "link-token",
      plaid_public_token: "public-token",
      status: "verified",
      identity_json: "{}",
      failure_reason: null,
      created_at: NOW().toISOString(),
      verified_at: NOW().toISOString(),
    });
    const stateRefusal = await releaseUnclaimedHolding(
      store,
      {
        holding_ledger_id: credit!.id,
        splits: [{ payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 }],
        operator_settlement_approved: true,
        vertical: "music",
      },
      NOW(),
    );
    expect(stateRefusal).toMatchObject({ ok: false, status: 403, code: "vertical_state_unknown" });

    // Both refusals left the credit exactly as the worker posted it — held.
    const stillHeld = await store.listUnclaimedHoldingCredits(100);
    expect(stillHeld.find((c) => c.id === credit!.id)?.status).toBe("unclaimed_holding");
  });

  it("the Don invariant through the whole chain: worker post → gated release → allocations + dust = gross, integer cents", async () => {
    const store = new InMemoryStore();
    const { ingestId } = await seedJob(store, "distrokid.csv", loadFixture("distrokid.csv"));
    await runOnce({ store, vault: vaultWithIsrc(), now: NOW });

    const credit = (await store.listUnclaimedHoldingCredits(100)).find(
      (c) => c.line_item_id === `recon:${ingestId}:line:1`,
    );
    expect(credit?.amount_cents).toBe(431);

    // Full verification: KYC + vault for every credited payee, music
    // separation settled, operator approval granted.
    for (const [payeeId, payeeName] of [
      ["creator_1", "Creator One"],
      ["creator_2", "Creator Two"],
      ["creator_3", "Creator Three"],
    ] as const) {
      await store.upsertVault({
        payee_id: payeeId,
        payee_name: payeeName,
        available_balance: 0,
        pending_balance: 0,
        reserve_balance: 0,
        updated_at: NOW().toISOString(),
      });
      await store.insertKycVerification({
        creator_id: payeeId,
        plaid_link_token: "link-token",
        plaid_public_token: "public-token",
        status: "verified",
        identity_json: "{}",
        failure_reason: null,
        created_at: NOW().toISOString(),
        verified_at: NOW().toISOString(),
      });
      await store.upsertCreatorTaxProfile({
        creator_id: payeeId,
        tin_verified: 1,
        w9_on_file: 1,
        updated_at: NOW().toISOString(),
      });
    }
    setVerticalComplianceStateSource(async () => ({
      vertical: "music",
      rights_separation_settled: true,
    }));

    // 3333 + 3333 + 3334 = 10000 bps — the whole-cent floor leaves dust.
    const release = await releaseUnclaimedHolding(
      store,
      {
        holding_ledger_id: credit!.id,
        splits: [
          { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 3333 },
          { payee_id: "creator_2", payee_name: "Creator Two", role: "creator", share_bps: 3333 },
          { payee_id: "creator_3", payee_name: "Creator Three", role: "creator", share_bps: 3334 },
        ],
        operator_settlement_approved: true,
        vertical: "music",
      },
      NOW(),
    );
    if (!release.ok) {
      throw new Error(`release failed: ${release.status} ${release.code}: ${release.message}`);
    }
    const grossAllocated = release.value.party_credits.reduce((sum, p) => sum + p.gross_cents, 0);
    expect(grossAllocated + release.value.company_dust_cents).toBe(431); // allocations + dust = gross
    for (const p of release.value.party_credits) {
      expect(Number.isSafeInteger(p.gross_cents)).toBe(true);
      expect(Number.isSafeInteger(p.net_cents)).toBe(true);
    }
  });
});

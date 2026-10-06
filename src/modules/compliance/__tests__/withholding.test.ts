/**
 * Withholding unit suite (audit note_c5ksDgVw #8 — no direct tests existed).
 *
 * Locks the Don engine's withholding contract at three layers:
 *
 *   • computeWithholding — the 24% backup floor (floor-only integer cents,
 *     the locked TIN conjunction: both flags must be true to release clean),
 *     the $600 1099 exact crossing, and the crossed_1099_threshold edge
 *     (only THE crossing payment carries the flag).
 *   • applyWithholding — the replay contract (migration 0060, audit #12):
 *     a replayed apply with the same idempotency key returns the STORED
 *     effect — one escrow row, one YTD accumulation — mirroring the
 *     split-run saga's key pattern, plus year isolation (a crossing in one
 *     tax year never flips another year's threshold).
 *   • resolvePayeePayouts — the admin fold evaluates form thresholds per
 *     (identityKey, taxYear), not against lifetime totals (audit #9).
 *
 * Rigor mirrors dust.test.ts: tabular case matrices, exact integer-cent
 * assertions, and both backends that can host the full engine flow without
 * a live database.
 */

import { describe, expect, it } from "vitest";
import { applyWithholding, readCreatorCompliance } from "../engine";
import { computeWithholding, type TinStatus } from "../withholding";
import { validateWithholdingPayload } from "@/lib/don/validation";
import { FORM_1099_THRESHOLD_CENTS } from "@/modules/don/constants";
import type { Store } from "@/lib/server/store";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { resolvePayeePayouts } from "@/lib/tax/withholding";
import { identityKeyFromPayeeId } from "@/lib/tax/payeeProfiles";
import type { LedgerRow } from "@/lib/ledger/store";
import type { DisbursementDetail, BankRoutingInstruction } from "@/engine/covenant-master-sdk";

const CREATOR = "cr_withholding_suite";
const VERIFIED: TinStatus = { tin_verified: true, w9_on_file: true };
const UNVERIFIED: TinStatus = { tin_verified: false, w9_on_file: false };
const HALF_VERIFIED: TinStatus = { tin_verified: true, w9_on_file: false };

/** The two backends that can host the full engine flow without a live DB. */
const backends: Array<{ name: string; make: () => Store }> = [
  { name: "in-memory", make: () => new InMemoryStore() },
  { name: "sqlite", make: () => new SqliteStore(":memory:") },
];

/** Deterministic settlement clocks: one per sequence index, all in January. */
const settledAt = (year: number, i: number) => new Date(Date.UTC(year, 0, 10, 0, 0, i));

/** Backup withholding the engine applies to an unverified payout (floor 24%). */
const backupOn = (gross: number) => Math.floor((gross * 2_400) / 10_000);

/** Gross payouts that sweep the 24% floor's rounding edges and the $600 boundary. */
const FLOOR_GROSS_CASES = [1, 2, 3, 99, 700, 10_000, 59_999, 60_000, 123_457, 1_000_000];

describe("computeWithholding — the 24% backup floor (audit #8)", () => {
  it("withholds floor-only 24% of every gross when the TIN is unverified", () => {
    for (const gross of FLOOR_GROSS_CASES) {
      const computation = computeWithholding(gross, 0, 0, UNVERIFIED);
      expect(computation.withheld_cents).toBe(Math.floor((gross * 2_400) / 10_000));
      expect(computation.net_cents).toBe(gross - computation.withheld_cents);
      expect(computation.backup_withholding_applied).toBe(computation.withheld_cents > 0);
    }
  });

  it("floors to the cent — a 1-cent unverified payout withholds 0, never rounds up", () => {
    const computation = computeWithholding(1, 0, 0, UNVERIFIED);
    expect(computation.withheld_cents).toBe(0);
    expect(computation.backup_withholding_applied).toBe(false);
    expect(computation.net_cents).toBe(1);
  });

  it("withholds on a HALF-verified TIN — both flags must be true to release clean", () => {
    for (const gross of FLOOR_GROSS_CASES) {
      expect(computeWithholding(gross, 0, 0, HALF_VERIFIED).withheld_cents).toBe(backupOn(gross));
    }
  });

  it("releases clean only when BOTH flags are verified", () => {
    for (const gross of FLOOR_GROSS_CASES) {
      const computation = computeWithholding(gross, 0, 0, VERIFIED);
      expect(computation.withheld_cents).toBe(0);
      expect(computation.backup_withholding_applied).toBe(false);
      expect(computation.net_cents).toBe(gross);
    }
  });

  it("accumulates the prior YTD into the returned totals", () => {
    const computation = computeWithholding(700, 10_000, 2_400, UNVERIFIED);
    expect(computation.ytd_gross_cents).toBe(10_700);
    expect(computation.ytd_withheld_cents).toBe(2_400 + backupOn(700));
  });
});

describe("computeWithholding — the $600 exact crossing and the crossed edge (audit #8)", () => {
  it(`crosses exactly at ${FORM_1099_THRESHOLD_CENTS} cents — one cent under does not`, () => {
    expect(FORM_1099_THRESHOLD_CENTS).toBe(60_000);
    const justUnder = computeWithholding(59_999, 0, 0, VERIFIED);
    expect(justUnder.requires_1099).toBe(false);
    expect(justUnder.crossed_1099_threshold).toBe(false);

    const exact = computeWithholding(1, 59_999, 0, VERIFIED);
    expect(exact.requires_1099).toBe(true);
    expect(exact.crossed_1099_threshold).toBe(true);

    const fromZero = computeWithholding(60_000, 0, 0, VERIFIED);
    expect(fromZero.requires_1099).toBe(true);
    expect(fromZero.crossed_1099_threshold).toBe(true);
  });

  it("flags only THE crossing payment — the next payout carries crossed = false again", () => {
    const crossing = computeWithholding(1, 59_999, 0, VERIFIED);
    expect(crossing.crossed_1099_threshold).toBe(true);

    const after = computeWithholding(1, 60_000, 0, VERIFIED);
    expect(after.requires_1099).toBe(true);
    expect(after.crossed_1099_threshold).toBe(false);
  });

  it("tracks the 1099 requirement for verified creators too — forms are independent of withholding", () => {
    const computation = computeWithholding(60_000, 0, 0, VERIFIED);
    expect(computation.requires_1099).toBe(true);
    expect(computation.withheld_cents).toBe(0);
  });
});

describe("applyWithholding — YTD accumulation and escrow bookkeeping", () => {
  it.each(backends)("$name: sequential settlements accumulate exactly", async ({ make }) => {
    const store = make();
    const gross = 700;

    for (let i = 0; i < 3; i++) {
      const result = await applyWithholding(
        store,
        { creator_id: CREATOR, gross_cents: gross, tax_year: 2026 },
        settledAt(2026, i),
      );
      expect(result.value.withheld_cents).toBe(backupOn(gross));
      expect(result.value.escrow.tin_verified).toBe(0);
      expect(result.value.escrow.w9_on_file).toBe(0);
      expect(result.value.escrow.crossed_1099_threshold).toBe(0);
    }

    const ytd = await store.getCreatorYtd(CREATOR, 2026);
    expect(ytd?.gross_cents).toBe(3 * gross);
    expect(ytd?.withheld_cents).toBe(3 * backupOn(gross));

    const escrow = await store.listTaxEscrowByCreator(CREATOR, 2026);
    expect(escrow).toHaveLength(3);
    expect(escrow.reduce((sum, row) => sum + row.withheld_cents, 0)).toBe(3 * backupOn(gross));
  });
});

describe("applyWithholding — the idempotency key (migration 0060, audit #12)", () => {
  it.each(backends)(
    "$name: a replay with the same key returns the STORED effect and books nothing",
    async ({ make }) => {
      const store = make();
      const key = "replay-once";
      const at = settledAt(2026, 0);

      const first = await applyWithholding(
        store,
        { creator_id: CREATOR, gross_cents: 700, tax_year: 2026, idempotency_key: key },
        at,
      );
      expect(first.value.replayed).toBeUndefined();

      // The replay is HOSTILE: a different gross must not reprice the
      // stored effect — the original escrow row IS the effect of record.
      const replay = await applyWithholding(
        store,
        { creator_id: CREATOR, gross_cents: 1_000_000, tax_year: 2026, idempotency_key: key },
        settledAt(2026, 5),
      );

      expect(replay.value.replayed).toBe(true);
      expect(replay.value.escrow.id).toBe(first.value.escrow.id);
      expect(replay.value.gross_cents).toBe(first.value.gross_cents);
      expect(replay.value.withheld_cents).toBe(first.value.withheld_cents);
      expect(replay.value.net_cents).toBe(first.value.net_cents);
      expect(replay.value.crossed_1099_threshold).toBe(first.value.crossed_1099_threshold);

      // ONE escrow row, ONE YTD accumulation — the replay contributed zero.
      const escrow = await store.listTaxEscrowByCreator(CREATOR, 2026);
      expect(escrow).toHaveLength(1);
      const ytd = await store.getCreatorYtd(CREATOR, 2026);
      expect(ytd?.gross_cents).toBe(700);
      expect(ytd?.withheld_cents).toBe(backupOn(700));
      expect(replay.value.ytd_gross_cents).toBe(700);
    },
  );

  it.each(backends)(
    "$name: two concurrent applies racing one key produce one effect",
    async ({ make }) => {
      const store = make();
      const key = "race-one-effect";

      const [a, b] = await Promise.all([
        applyWithholding(
          store,
          { creator_id: CREATOR, gross_cents: 700, tax_year: 2026, idempotency_key: key },
          settledAt(2026, 0),
        ),
        applyWithholding(
          store,
          { creator_id: CREATOR, gross_cents: 999, tax_year: 2026, idempotency_key: key },
          settledAt(2026, 1),
        ),
      ]);

      // Both calls succeed and return the SAME stored escrow — the unique
      // index picked a winner and the loser re-read it.
      expect(a.value.escrow.id).toBe(b.value.escrow.id);
      expect(b.value.gross_cents).toBe(a.value.gross_cents);

      const escrow = await store.listTaxEscrowByCreator(CREATOR, 2026);
      expect(escrow).toHaveLength(1);
      const ytd = await store.getCreatorYtd(CREATOR, 2026);
      expect(ytd?.gross_cents).toBe(escrow[0].gross_cents);
      expect(ytd?.withheld_cents).toBe(escrow[0].withheld_cents);
    },
  );

  it.each(backends)(
    "$name: distinct keys are distinct effects; unkeyed rows stay distinct",
    async ({ make }) => {
      const store = make();

      const keyedA = await applyWithholding(
        store,
        { creator_id: CREATOR, gross_cents: 700, tax_year: 2026, idempotency_key: "run-1:item-1" },
        settledAt(2026, 0),
      );
      const keyedB = await applyWithholding(
        store,
        { creator_id: CREATOR, gross_cents: 700, tax_year: 2026, idempotency_key: "run-1:item-2" },
        settledAt(2026, 1),
      );
      const unkeyed = await applyWithholding(
        store,
        { creator_id: CREATOR, gross_cents: 700, tax_year: 2026 },
        settledAt(2026, 2),
      );

      expect(keyedA.value.escrow.id).not.toBe(keyedB.value.escrow.id);
      expect(keyedB.value.replayed).toBeUndefined();
      expect(unkeyed.value.replayed).toBeUndefined();
      expect(await store.listTaxEscrowByCreator(CREATOR, 2026)).toHaveLength(3);
      expect((await store.getCreatorYtd(CREATOR, 2026))?.gross_cents).toBe(3 * 700);
    },
  );
});

describe("applyWithholding — year isolation (audit #9)", () => {
  it.each(backends)(
    "$name: a crossing in one tax year never flips another year's threshold",
    async ({ make }) => {
      const store = make();

      // 2025 crosses the $600 threshold exactly.
      const crossing = await applyWithholding(
        store,
        { creator_id: CREATOR, gross_cents: FORM_1099_THRESHOLD_CENTS, tax_year: 2025 },
        settledAt(2025, 0),
      );
      expect(crossing.value.crossed_1099_threshold).toBe(true);

      // 2026 starts from ZERO — the 2025 total must not leak in.
      const nextYear = await applyWithholding(
        store,
        { creator_id: CREATOR, gross_cents: 1, tax_year: 2026 },
        settledAt(2026, 0),
      );
      expect(nextYear.value.requires_1099).toBe(false);
      expect(nextYear.value.crossed_1099_threshold).toBe(false);
      expect(nextYear.value.ytd_gross_cents).toBe(1);

      const snapshot2025 = await readCreatorCompliance(store, CREATOR, 2025);
      const snapshot2026 = await readCreatorCompliance(store, CREATOR, 2026);
      expect(snapshot2025.requires_1099).toBe(true);
      expect(snapshot2026.requires_1099).toBe(false);
      expect((await store.getCreatorYtd(CREATOR, 2025))?.gross_cents).toBe(60_000);
      expect((await store.getCreatorYtd(CREATOR, 2026))?.gross_cents).toBe(1);
    },
  );
});

/**
 * The admin fold's fixtures: one royalty disbursement per ledger row, USD.
 * The probe payee carries no demo branch → the fail-closed US profile, so
 * the founder engine's royalty form threshold ($10, MISC_ROYALTY_THRESHOLD)
 * governs the form trigger.
 */
/** A complete-but-arbitrary routing instruction: the fold never reads it. */
const probeRouting = (): BankRoutingInstruction => ({
  accountHolderName: "Fold Probe",
  bankName: "Probe Bank",
  accountNumberOrIBAN: "000000000",
  routingOrBIC: "PROBE0000",
  currency: "USD",
  countryCode: "US",
  planetaryJurisdiction: "EARTH",
  railType: "ACH",
});

function foldRow(
  transactionId: string,
  createdAt: string,
  rightsHolderId: string,
  grossShare: number,
): LedgerRow {
  const disbursement: DisbursementDetail = {
    rightsHolderId,
    rightsHolderName: "Fold Probe",
    role: "AUTHOR",
    grossShare,
    withholdingTaxRateApplied: 0,
    withholdingTaxDeducted: 0,
    netShare: grossShare,
    currency: "USD",
    isTaxReportable: false,
    taxFormRequired: "NONE",
    routing: probeRouting(),
  };
  return {
    transactionId,
    cbtCode: "CBT-FOLD-PROBE",
    platform: "test",
    grossSettled: grossShare,
    covenantFee: 0,
    cornerDustCollected: 0,
    currency: "USD",
    disbursements: [disbursement],
    createdAt,
  };
}

const EMPTY_JOINS = {
  entityTypeByCbt: new Map<string, string>(),
  templateByCbt: new Map<string, string>(),
  eventStateByCbt: new Map<string, string>(),
};

describe("resolvePayeePayouts — form thresholds evaluate the TAX YEAR (audit #9)", () => {
  it("a crossing in one year does not flip another year's form trigger", () => {
    const payee = "uct-fold-probe";
    const fold = resolvePayeePayouts(
      [
        foldRow("TX-2025", "2025-06-01T00:00:00.000Z", payee, 15),
        foldRow("TX-2026", "2026-06-01T00:00:00.000Z", payee, 2),
      ],
      EMPTY_JOINS,
    );

    expect(identityKeyFromPayeeId(payee)).toBe(payee);

    // 2025: $15 ≥ the $10 royalty threshold → 1099_MISC.
    expect(fold.payouts[0].resolution.formTriggered).toBe("1099_MISC");
    // 2026: the YEAR-scoped YTD is $2 — under the threshold even though the
    // LIFETIME total ($17) is not. The pre-fix fold evaluated lifetime and
    // wrongly triggered the form for 2026 (audit #9's exact bug).
    expect(fold.payouts[1].resolution.formTriggered).toBe("EXEMPT_CORPORATE");

    expect(fold.ytdByPayeeYear.get(`2025|${payee}`)).toBe(15);
    expect(fold.ytdByPayeeYear.get(`2026|${payee}`)).toBe(2);
    // The lifetime map stays for the register's all-time view.
    expect(fold.ytdByPayee.get(payee)).toBe(17);
  });

  it("resolves the demo door's branch through the fold with its own year scope", () => {
    // A demo-branch payee (identity-founder: US/TX, verified) exercises the
    // profileFromDemoBranch adapter through the same fold.
    const payee = "identity-founder-demo-2026";
    const fold = resolvePayeePayouts(
      [
        foldRow("DIR-DEMO-1", "2026-03-01T00:00:00.000Z", payee, 4),
        foldRow("DIR-DEMO-2", "2026-09-01T00:00:00.000Z", payee, 6),
      ],
      EMPTY_JOINS,
    );

    const identityKey = identityKeyFromPayeeId(payee);
    expect(identityKey).toBe("identity-founder");
    // Both payouts stay in 2026, so the year map accumulates across them.
    expect(fold.ytdByPayeeYear.get(`2026|${identityKey}`)).toBe(10);
    // $4 alone is under the $10 royalty threshold; $4+$6 crosses it.
    expect(fold.payouts[0].resolution.formTriggered).toBe("EXEMPT_CORPORATE");
    expect(fold.payouts[1].resolution.formTriggered).toBe("1099_MISC");
  });
});

describe("validateWithholdingPayload — the key's ingestion contract", () => {
  it("passes a trimmed key through", () => {
    const parsed = validateWithholdingPayload({
      creator_id: "cr_1",
      gross_cents: 700,
      idempotency_key: "  replay-once  ",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.idempotency_key).toBe("replay-once");
  });

  it("treats an absent, null, or empty key as no key", () => {
    for (const idempotency_key of [undefined, null, "", "   "]) {
      const parsed = validateWithholdingPayload({
        creator_id: "cr_1",
        gross_cents: 700,
        idempotency_key,
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.idempotency_key).toBeUndefined();
    }
  });

  it("fails a non-string key — a caller that thinks it sent one must not silently lose replay protection", () => {
    const parsed = validateWithholdingPayload({
      creator_id: "cr_1",
      gross_cents: 700,
      idempotency_key: 12_345,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe("invalid_idempotency_key");
  });

  it("fails an over-long key instead of truncating it (truncation could equal ANOTHER payment's key)", () => {
    const parsed = validateWithholdingPayload({
      creator_id: "cr_1",
      gross_cents: 700,
      idempotency_key: "k".repeat(201),
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe("invalid_idempotency_key");
  });
});

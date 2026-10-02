// Store-backed tests for the book editorial cascade (PR 26) — the durable
// behaviors the pure-math tests do not isolate: the sequential advance
// recoupment's switchover through the real pool CAS, the pool-class
// isolation firewall (an e-book sale never recoups a print advance), the
// currency firewall, the magazine roster's flat-once-per-issue vs
// percentage-per-funding-event modes, and the whole pass's replay
// idempotency (a re-shipped report is counted no-ops, never double money).

import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  accrueBookEditorialSplit,
  applyBookRecoupment,
  bookFlatCutAllocations,
  bookPercentageSplits,
  magazineFlatCutEventId,
  magazineScheduleTitleKey,
  registerBookEditorialSplitSchedule,
  registerBookRecoupmentPool,
  runBookEditorialSplitPass,
} from "@/lib/server/bookEditorialCascade";
import type { BookEditorialContributorSpec } from "@/modules/don/records";
import type { BookLineDetail, ParsedStatementLine } from "@/workers/recon/records";
import type { BookLineOutcome, BookWriteCounts } from "@/workers/recon/booksQueue";

const NOW = new Date("2026-10-02T09:00:00Z");
const ISBN = "9781612198300";

function contributor(
  overrides: Partial<BookEditorialContributorSpec> & Pick<BookEditorialContributorSpec, "payee_id" | "role">,
): BookEditorialContributorSpec {
  return {
    payee_name: overrides.payee_id,
    mode: "percentage",
    flat_cents: null,
    percentage_bps: null,
    pro_rata_count: null,
    ...overrides,
  };
}

function poolRegistration(
  overrides: Partial<Parameters<typeof registerBookRecoupmentPool>[1]> = {},
) {
  return {
    isbn: ISBN,
    pool_class: "print_advance" as const,
    sequence_no: 1,
    advance_cents: 1_000,
    currency: "USD",
    advance_agreement_ref: "agmt-001",
    ...overrides,
  };
}

/** A minimal honest ParsedStatementLine carrying a book detail. */
function bookLine(
  detail: BookLineDetail,
  overrides: Partial<ParsedStatementLine> = {},
): ParsedStatementLine {
  return {
    lineNumber: 1,
    profile: "book_pod_print_csv",
    rightsType: "unknown",
    statementSourceType: null,
    tierLevel: null,
    rightsPipeline: "composition_performance",
    period: "2026-10",
    currency: "USD",
    grossMicros: 1_000_000_000n,
    isAdjustment: false,
    identifiers: {},
    workTitle: null,
    territory: null,
    platform: null,
    usageNote: "book lane row",
    raw: [],
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    merchDetail: null,
    aiDetail: null,
    bookDetail: detail,
    ...overrides,
  };
}

function outcome(
  detail: BookLineDetail,
  eventId: string,
  netCents: number,
  overrides: Partial<BookLineOutcome> = {},
): BookLineOutcome {
  return {
    line: bookLine(detail),
    eventId,
    matchedCbtCode: "CBT-BOOK",
    disposition: "money",
    netCents,
    deductionMicros: "0",
    detail,
    ...overrides,
  };
}

function counts(lineOutcomes: BookLineOutcome[]): BookWriteCounts {
  return {
    written: lineOutcomes.length,
    alreadyPresent: 0,
    matched: lineOutcomes.length,
    unmatched: 0,
    heldNegativeNet: 0,
    zeroNet: 0,
    printDeductionMicros: 0n,
    lineOutcomes,
  };
}

const printDetail: Extract<BookLineDetail, { kind: "print_sale" }> = {
  kind: "print_sale",
  platform: "amazon_kdp",
  isbn: ISBN,
  formatType: "paperback",
  orderId: "ord-001",
  units: 1,
  grossRetailMicros: "1000000000",
  printingCostPerUnitMicros: "231000000",
  distributionFeeMicros: "20000000",
  channelDiscountBps: 5500,
  period: "2026-10",
};

const ebookDetail: Extract<BookLineDetail, { kind: "ebook_sale" }> = {
  kind: "ebook_sale",
  platform: "kobo",
  isbn: ISBN,
  orderId: "ord-002",
  units: 1,
  listPriceMicros: "999000000",
  period: "2026-10",
};

// ---------------------------------------------------------------------------
// Registration validation — the fail-closed gates.
// ---------------------------------------------------------------------------

describe("registerBookRecoupmentPool", () => {
  it("registers the pool of record", async () => {
    const store = new InMemoryStore();
    const pool = await registerBookRecoupmentPool(store, poolRegistration(), NOW);
    if ("ok" in pool) throw new Error(`registration failed: ${pool.message}`);
    expect(pool.isbn).toBe(ISBN);
    expect(pool.status).toBe("active");
    expect(pool.recouped_cents).toBe(0);
  });

  it("refuses a duplicate sequence slot — the unique violation, never a silent duplicate", async () => {
    const store = new InMemoryStore();
    await registerBookRecoupmentPool(store, poolRegistration(), NOW);
    const again = await registerBookRecoupmentPool(store, poolRegistration(), NOW);
    expect(again).toMatchObject({ ok: false, code: "recoupment_pool_already_registered" });
  });
});

// ---------------------------------------------------------------------------
// Sequential advance recoupment — 100% until clear, exact switchover.
// ---------------------------------------------------------------------------

describe("applyBookRecoupment — the switchover through the store", () => {
  it("fills pools in sequence order and flips each pool's status at clearance", async () => {
    const store = new InMemoryStore();
    const first = await registerBookRecoupmentPool(
      store,
      poolRegistration({ advance_cents: 1_000 }),
      NOW,
    );
    const second = await registerBookRecoupmentPool(
      store,
      poolRegistration({ sequence_no: 2, advance_cents: 500 }),
      NOW,
    );
    if ("ok" in first) throw new Error(`registration failed: ${first.message}`);
    if ("ok" in second) throw new Error(`registration failed: ${second.message}`);

    // Event 1: 1,200 cents — 1,000 to pool 1, 200 to pool 2; nothing to splits.
    const appliedOne = await applyBookRecoupment(store, {
      isbn: ISBN,
      pool_class: "print_advance",
      source_event_id: "evt-print-1",
      revenue_cents: 1_200,
      currency: "USD",
    }, NOW);
    if (!appliedOne.ok) throw new Error(appliedOne.message);
    expect(appliedOne.value.applications.map((a) => [a.pool_id === first.id ? 1 : 2, a.applied_cents]))
      .toEqual([[1, 1_000], [2, 200]]);
    expect(appliedOne.value.recouped_cents).toBe(1_200);
    expect(appliedOne.value.excess_cents).toBe(0);
    expect(appliedOne.value.pools_remaining_open).toBe(true);

    // Event 2: 17,500 cents — pool 2's last 300 recoup; the remainder
    // (17,200) is the splits' basis THE SAME EVENT — the exact switchover.
    const appliedTwo = await applyBookRecoupment(store, {
      isbn: ISBN,
      pool_class: "print_advance",
      source_event_id: "evt-print-2",
      revenue_cents: 17_500,
      currency: "USD",
    }, NOW);
    if (!appliedTwo.ok) throw new Error(appliedTwo.message);
    expect(appliedTwo.value.recouped_cents).toBe(300);
    expect(appliedTwo.value.excess_cents).toBe(17_200);
    expect(appliedTwo.value.pools_remaining_open).toBe(false);

    // The pools of record track the recovery (the derived read).
    const pools = await store.listBookRecoupmentPools(ISBN, "print_advance");
    expect(pools.map((p) => [p.recouped_cents, p.status])).toEqual([
      [1_000, "recouped"],
      [500, "recouped"],
    ]);
  });

  it("refuses a replayed revenue event — 409, never a double recovery", async () => {
    const store = new InMemoryStore();
    await registerBookRecoupmentPool(store, poolRegistration(), NOW);
    const input = {
      isbn: ISBN,
      pool_class: "print_advance" as const,
      source_event_id: "evt-print-1",
      revenue_cents: 400,
      currency: "USD",
    };
    const first = await applyBookRecoupment(store, input, NOW);
    expect(first.ok).toBe(true);
    const replay = await applyBookRecoupment(store, input, NOW);
    expect(replay).toMatchObject({ ok: false, status: 409, code: "recoupment_event_already_applied" });
  });

  it("refuses revenue with no registered pool — fail-closed, never silently unpooled", async () => {
    const store = new InMemoryStore();
    const result = await applyBookRecoupment(store, {
      isbn: ISBN,
      pool_class: "audiobook_production_unrecouped",
      source_event_id: "evt-audio-1",
      revenue_cents: 900,
      currency: "USD",
    }, NOW);
    expect(result).toMatchObject({ ok: false, status: 404, code: "recoupment_pool_not_registered" });
  });
});

// ---------------------------------------------------------------------------
// The isolation firewall — pool classes never cross-collateralize.
// ---------------------------------------------------------------------------

describe("applyBookRecoupment — pool-class and currency isolation", () => {
  it("an e-book sale recoups ONLY the e-book pool", async () => {
    const store = new InMemoryStore();
    await registerBookRecoupmentPool(store, poolRegistration(), NOW);
    await registerBookRecoupmentPool(
      store,
      poolRegistration({ pool_class: "ebook_advance", advance_cents: 400 }),
      NOW,
    );

    const applied = await applyBookRecoupment(store, {
      isbn: ISBN,
      pool_class: "ebook_advance",
      source_event_id: "evt-ebook-1",
      revenue_cents: 250,
      currency: "USD",
    }, NOW);
    if (!applied.ok) throw new Error(applied.message);

    const printPools = await store.listBookRecoupmentPools(ISBN, "print_advance");
    const ebookPools = await store.listBookRecoupmentPools(ISBN, "ebook_advance");
    expect(printPools[0]?.recouped_cents).toBe(0); // untouched
    expect(ebookPools[0]?.recouped_cents).toBe(250);
  });

  it("reports a currency-mismatched pool instead of pooling the money", async () => {
    const store = new InMemoryStore();
    const pool = await registerBookRecoupmentPool(
      store,
      poolRegistration({ currency: "USD" }),
      NOW,
    );
    if ("ok" in pool) throw new Error(`registration failed: ${pool.message}`);

    const applied = await applyBookRecoupment(store, {
      isbn: ISBN,
      pool_class: "print_advance",
      source_event_id: "evt-eur-1",
      revenue_cents: 300,
      currency: "EUR",
    }, NOW);
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.value.applications).toEqual([]);
    expect(applied.value.mismatched_pools).toEqual([
      { pool_id: pool.id, pool_currency: "USD" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Allocation helpers — percentage (retained complement) and flat cuts.
// ---------------------------------------------------------------------------

describe("bookPercentageSplits and bookFlatCutAllocations", () => {
  it("floors each percentage share; the complement stays the title's retained share", () => {
    const { allocations, dustCents } = bookPercentageSplits(1_000, [
      contributor({ payee_id: "payee-a", role: "contributing_author", percentage_bps: 3_333 }),
      contributor({ payee_id: "payee-b", role: "senior_editor", percentage_bps: 3_333 }),
    ]);
    expect(allocations.map((a) => a.share_cents)).toEqual([333, 333]);
    expect(dustCents).toBe(0); // the 334-cent complement is RETAINED, not dust
  });

  it("flat cuts are the contracted fees themselves, basis zero", () => {
    const allocations = bookFlatCutAllocations([
      contributor({ payee_id: "payee-cover", role: "cover_artist", mode: "flat_per_issue", flat_cents: 2_500 }),
      contributor({ payee_id: "payee-layout", role: "layout_designer", mode: "flat_per_issue", flat_cents: 1_800 }),
    ]);
    expect(allocations.map((a) => [a.payee_id, a.share_cents])).toEqual([
      ["payee-cover", 2_500],
      ["payee-layout", 1_800],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The worker pass — magazine modes, recoupment, and replay idempotency.
// ---------------------------------------------------------------------------

function magazineIssueOutcome(eventId: string): BookLineOutcome {
  const detail: Extract<BookLineDetail, { kind: "magazine_issue" }> = {
    kind: "magazine_issue",
    platform: "zinio",
    magazineId: "mag-atlas-monthly",
    issueId: "iss-2026-10",
    eventId,
    units: 1,
    grossMicros: "500000000",
    period: "2026-10",
  };
  return outcome(detail, eventId, 500);
}

function magazineSubscriptionOutcome(eventId: string, grossMicros: string): BookLineOutcome {
  const detail: Extract<BookLineDetail, { kind: "magazine_subscription" }> = {
    kind: "magazine_subscription",
    platform: "substack",
    magazineId: "mag-atlas-monthly",
    issueId: "iss-2026-10",
    eventId,
    units: 1,
    grossMicros,
    period: "2026-10",
  };
  return outcome(detail, eventId, 1_000);
}

describe("runBookEditorialSplitPass — magazine editorial cuts", () => {
  it("accrues the flat cut ONCE per issue and percentage cuts per funding event", async () => {
    const store = new InMemoryStore();
    const schedule = await registerBookEditorialSplitSchedule(store, {
      title_key: magazineScheduleTitleKey("iss-2026-10"),
      scope: "magazine_issue",
      mode: "flat_per_issue",
      pro_rata_basis: null,
      contributors: [
        contributor({ payee_id: "payee-cover", role: "cover_artist", mode: "flat_per_issue", flat_cents: 2_500 }),
        contributor({ payee_id: "payee-columnist", role: "featured_columnist", mode: "flat_per_issue", flat_cents: 1_200 }),
        contributor({ payee_id: "payee-editor", role: "senior_editor", percentage_bps: 1_500 }),
        contributor({ payee_id: "payee-layout", role: "layout_designer", mode: "flat_per_issue", flat_cents: 800 }),
      ],
    }, NOW);
    if ("ok" in schedule) throw new Error("schedule registration failed");

    // Two single-issue sale rows (the flat trigger fires on the first) and
    // two subscription funding rows (each accrues its percentage cuts).
    const passOne = await runBookEditorialSplitPass(store, counts([
      magazineIssueOutcome("evt-issue-1"),
      magazineIssueOutcome("evt-issue-2"),
      magazineSubscriptionOutcome("evt-sub-1", "1000000000"),
      magazineSubscriptionOutcome("evt-sub-2", "500000000"),
    ]), NOW);

    // Flat: exactly one accrual (once per issue per schedule version);
    // the second issue row's flat re-attempt is a counted replay — that is
    // the once-per-issue guard working. Percentage: one per funding event.
    expect(passOne.splitAccruals).toBe(3);
    expect(passOne.splitAccrualsReplayed).toBe(1);
    expect(passOne.recoupmentsApplied).toBe(0); // magazine rows carry no pool

    // The subscription accruals carry the PERCENTAGE contributors' cuts —
    // never a second flat accrual.
    const subOne = await accrueBookEditorialSplit(store, {
      schedule: { ...schedule, mode: "percentage" },
      source_event_id: "evt-sub-1",
      basis_cents: 100_000,
    }, NOW);
    expect(subOne).toEqual({ accrual: null, replayed: true }); // already accrued by the pass

    // A re-shipped report replays as counted no-ops.
    const passTwo = await runBookEditorialSplitPass(store, counts([
      magazineIssueOutcome("evt-issue-1"),
      magazineIssueOutcome("evt-issue-2"),
      magazineSubscriptionOutcome("evt-sub-1", "1000000000"),
      magazineSubscriptionOutcome("evt-sub-2", "500000000"),
    ]), NOW);
    expect(passTwo.splitAccruals).toBe(0);
    expect(passTwo.splitAccrualsReplayed).toBe(4); // flat replay x2 + 2 subs
  });

  it("skips magazine rows with no schedule — visible, never silent", async () => {
    const store = new InMemoryStore();
    const pass = await runBookEditorialSplitPass(store, counts([
      magazineIssueOutcome("evt-issue-unregistered"),
    ]), NOW);
    expect(pass.skippedNoSchedule).toBe(1);
  });
});

describe("runBookEditorialSplitPass — book streams", () => {
  it("recoups through each row's own pool class, then splits the excess", async () => {
    const store = new InMemoryStore();
    await registerBookRecoupmentPool(store, poolRegistration({ advance_cents: 1_000 }), NOW);
    await registerBookRecoupmentPool(
      store,
      poolRegistration({ pool_class: "ebook_advance", advance_cents: 400 }),
      NOW,
    );
    // The title's post-clearance schedule — 70/30 standard splits.
    const schedule = await registerBookEditorialSplitSchedule(store, {
      title_key: ISBN,
      scope: "book",
      mode: "percentage",
      pro_rata_basis: null,
      contributors: [
        contributor({ payee_id: "payee-author", role: "contributing_author", percentage_bps: 7_000 }),
        contributor({ payee_id: "payee-publisher", role: "senior_editor", percentage_bps: 3_000 }),
      ],
    }, NOW);
    if ("ok" in schedule) throw new Error("schedule registration failed");

    const pass = await runBookEditorialSplitPass(store, counts([
      outcome(printDetail, "evt-print-1", 1_200), // clears pool 1, spills 200
      outcome(ebookDetail, "evt-ebook-1", 250), // recoups its OWN pool
    ]), NOW);

    expect(pass.recoupmentsApplied).toBe(2); // one application per event
    expect(pass.recoupmentAppliedCents).toBe(1_250); // 1,000 print + 250 ebook; the 200 print spill is excess, not recouped
    expect(pass.recoupmentExcessCents).toBe(200); // the print row's switchover
    expect(pass.splitAccruals).toBe(1); // the print row's excess split (70/30)
    expect(pass.skippedNoPool).toBe(0);
    expect(pass.skippedCurrencyMismatch).toBe(0);

    const pools = await store.listBookRecoupmentPools(ISBN, "print_advance");
    expect(pools[0]).toMatchObject({ recouped_cents: 1_000, status: "recouped" });
    const ebookPools = await store.listBookRecoupmentPools(ISBN, "ebook_advance");
    expect(ebookPools[0]).toMatchObject({ recouped_cents: 250, status: "active" });

    // A replay of the same ingest: every event 409s — counted no-ops.
    const replay = await runBookEditorialSplitPass(store, counts([
      outcome(printDetail, "evt-print-1", 1_200),
      outcome(ebookDetail, "evt-ebook-1", 250),
    ]), NOW);
    expect(replay.recoupmentsApplied).toBe(0);
    expect(replay.recoupmentsReplayed).toBe(2);
    expect(replay.splitAccruals).toBe(0);
    // Both recoupments 409 before any split basis exists — no accrual
    // attempts are made at all, so nothing accrues OR replays.
    expect(replay.splitAccrualsReplayed).toBe(0);
  });

  it("skips recoupment for unregistered pools and unmatched rows — visible skips", async () => {
    const store = new InMemoryStore();
    const pass = await runBookEditorialSplitPass(store, counts([
      outcome(printDetail, "evt-no-pool", 500),
      outcome(printDetail, "evt-unmatched", 500, { matchedCbtCode: null }), // unattributable
      outcome(printDetail, "evt-held", 500, { disposition: "held_negative_net" }), // quarantined
      outcome(printDetail, "evt-zero", 0, { disposition: "zero_net" }),
    ]), NOW);
    expect(pass.skippedNoPool).toBe(1);
    expect(pass.recoupmentsApplied).toBe(0);
  });

  it("accrues the magazine flat cut keyed per schedule version — a re-registration re-cuts", async () => {
    const store = new InMemoryStore();
    const v1 = await registerBookEditorialSplitSchedule(store, {
      title_key: magazineScheduleTitleKey("iss-2026-11"),
      scope: "magazine_issue",
      mode: "flat_per_issue",
      pro_rata_basis: null,
      contributors: [
        contributor({ payee_id: "payee-artist", role: "cover_artist", mode: "flat_per_issue", flat_cents: 2_000 }),
      ],
    }, NOW);
    if ("ok" in v1) throw new Error(`schedule registration failed: ${v1.message}`);
    // The trigger row's issue must MATCH the schedule's issue key.
    const v1Detail: Extract<BookLineDetail, { kind: "magazine_issue" }> = {
      kind: "magazine_issue",
      platform: "zinio",
      magazineId: "mag-atlas-monthly",
      issueId: "iss-2026-11",
      eventId: "evt-issue-v1",
      units: 1,
      grossMicros: "500000000",
      period: "2026-11",
    };
    const passOne = await runBookEditorialSplitPass(store, counts([
      outcome(v1Detail, "evt-issue-v1", 500),
    ]), NOW);
    expect(passOne.splitAccruals).toBe(1);

    // The roster's fee renegotiates — the upsert increments the version;
    // the flat cut's event identity carries the version, so the new
    // version's cut accrues on the next trigger (history, never re-cut).
    const v2 = await registerBookEditorialSplitSchedule(store, {
      title_key: magazineScheduleTitleKey("iss-2026-11"),
      scope: "magazine_issue",
      mode: "flat_per_issue",
      pro_rata_basis: null,
      contributors: [
        contributor({ payee_id: "payee-artist", role: "cover_artist", mode: "flat_per_issue", flat_cents: 2_500 }),
      ],
    }, NOW);
    if ("ok" in v2) throw new Error(`schedule re-registration failed: ${v2.message}`);
    expect(v2.version).toBe(2);
    expect(magazineFlatCutEventId("iss-2026-11", 1)).not.toBe(
      magazineFlatCutEventId("iss-2026-11", 2),
    );
  });
});

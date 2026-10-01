/**
 * The podcast episode-split + guest-bonus engine (PR 11) — the pure gate's
 * suite. No store, no IO: the registration validations, the integer-cent
 * allocation with the dust sweep, the milestone crossing math, and the
 * content-derived replay ids. The store-touching parity suite lives in
 * accrualParity.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  allocateSplitCents,
  bpsToPercent,
  crossesMilestone,
  guestBonusEventId,
  podcastEpisodeIdOfQueueRow,
  validateEpisodeSplitSplits,
  validateGuestBonusDefinition,
} from "../engine";
import { COMPANY_VARIANCE_PAYEE_ID, UNCLAIMED_HOLDING_PAYEE_ID } from "@/modules/don/constants";
import type { SplitPartyInput } from "@/lib/don/types";

const HOST: SplitPartyInput = {
  payee_id: "payee_host",
  payee_name: "The Host",
  role: "creator",
  share_bps: 6000,
};
const CO_HOST: SplitPartyInput = {
  payee_id: "payee_co_host",
  payee_name: "The Co-Host",
  role: "producer",
  share_bps: 3000,
};
const EDITOR: SplitPartyInput = {
  payee_id: "payee_editor",
  payee_name: "The Editor",
  role: "other",
  share_bps: 1000,
};

describe("the 100.0000% invariant — a schedule saves only at exactly 10000 bps", () => {
  it("accepts a schedule that sums to exactly 10000 bps", () => {
    const validated = validateEpisodeSplitSplits([HOST, CO_HOST, EDITOR]);
    expect(validated.ok).toBe(true);
  });

  it("refuses 9999 bps — one basis point under", () => {
    const validated = validateEpisodeSplitSplits([
      HOST,
      CO_HOST,
      { ...EDITOR, share_bps: 999 },
    ]);
    expect(validated).toMatchObject({ ok: false });
    if (!validated.ok) {
      expect(validated.message).toContain("9999 bps (99.99%)");
    }
  });

  it("refuses 10001 bps — one basis point over", () => {
    const validated = validateEpisodeSplitSplits([
      HOST,
      CO_HOST,
      { ...EDITOR, share_bps: 1001 },
    ]);
    expect(validated).toMatchObject({ ok: false });
    if (!validated.ok) {
      expect(validated.message).toContain("10001 bps (100.01%)");
    }
  });

  it("refuses an empty schedule", () => {
    expect(validateEpisodeSplitSplits([])).toMatchObject({ ok: false });
  });

  it("refuses a duplicate payee", () => {
    const validated = validateEpisodeSplitSplits([HOST, { ...CO_HOST, payee_id: HOST.payee_id }]);
    expect(validated).toMatchObject({ ok: false });
  });

  it("refuses the unclaimed-holding and variance sentinels as payees", () => {
    for (const payee_id of [UNCLAIMED_HOLDING_PAYEE_ID, COMPANY_VARIANCE_PAYEE_ID]) {
      const validated = validateEpisodeSplitSplits([{ ...HOST, payee_id }]);
      expect(validated).toMatchObject({ ok: false });
    }
  });

  it("refuses a float share — integer bps only, never rounded", () => {
    const validated = validateEpisodeSplitSplits([
      HOST,
      CO_HOST,
      { ...EDITOR, share_bps: 1000.5 },
    ]);
    expect(validated).toMatchObject({ ok: false });
  });
});

describe("allocateSplitCents — per-holder floor shares, dust sweeps the remainder", () => {
  it("allocates a clean amount exactly to the cent, zero dust", () => {
    const allocation = allocateSplitCents(1000, [HOST, CO_HOST, EDITOR]);
    expect(allocation.ok).toBe(true);
    if (allocation.ok) {
      expect(allocation.splits.map((party) => party.amount_cents)).toEqual([600, 300, 100]);
      expect(allocation.company_dust_cents).toBe(0);
    }
  });

  it("sweeps the integer-cent remainder as company dust", () => {
    // 101¢: floors are 60 + 30 + 10 = 100 — the 1¢ remainder is dust.
    const allocation = allocateSplitCents(101, [HOST, CO_HOST, EDITOR]);
    expect(allocation.ok).toBe(true);
    if (allocation.ok) {
      expect(allocation.splits.map((party) => party.amount_cents)).toEqual([60, 30, 10]);
      expect(allocation.company_dust_cents).toBe(1);
      // The locked invariant: allocations plus dust equals gross.
      const gross = allocation.splits.reduce((sum, party) => sum + party.amount_cents, 0) +
        allocation.company_dust_cents;
      expect(gross).toBe(101);
    }
  });

  it("keeps the invariant on a sub-dollar amount across three holders", () => {
    // 7¢ at 3334/3333/3333: floors 2 + 2 + 2 = 6, dust 1.
    const allocation = allocateSplitCents(7, [
      { ...HOST, share_bps: 3334 },
      { ...CO_HOST, share_bps: 3333 },
      { ...EDITOR, share_bps: 3333 },
    ]);
    expect(allocation.ok).toBe(true);
    if (allocation.ok) {
      expect(allocation.company_dust_cents).toBe(1);
    }
  });

  it("re-validates a corrupt stored schedule and refuses the accrual", () => {
    // A schedule stored unbalanced (corrupt write, migration drift) must
    // fail the accrual — never allocated against, never silently skipped.
    const corrupt: SplitPartyInput[] = [HOST, { ...CO_HOST, share_bps: 3001 }];
    const allocation = allocateSplitCents(1000, corrupt);
    expect(allocation).toMatchObject({ ok: false });
    if (!allocation.ok) {
      expect(allocation.code).toBe("podcast_split_schedule_invalid");
    }
  });

  it("refuses a non-integer or non-positive source amount", () => {
    for (const amount of [0, -5, 10.5]) {
      const allocation = allocateSplitCents(amount, [HOST, CO_HOST, EDITOR]);
      expect(allocation).toMatchObject({ ok: false });
    }
  });
});

describe("crossesMilestone — verified totals only, threshold inclusive", () => {
  it("fires exactly at the threshold", () => {
    expect(crossesMilestone(1000, 1000)).toBe(true);
  });

  it("fires above the threshold", () => {
    expect(crossesMilestone(1000, 1001)).toBe(true);
  });

  it("does not fire below the threshold", () => {
    expect(crossesMilestone(1000, 999)).toBe(false);
  });

  it("refuses a malformed threshold instead of guessing", () => {
    expect(crossesMilestone(0, 1000)).toBe(false);
    expect(crossesMilestone(10.5, 1000)).toBe(false);
  });
});

describe("guestBonusEventId — the content-derived replay arbiter", () => {
  it("derives the same id from the same episode data — no clock, no counter", () => {
    const first = guestBonusEventId("ep-1", "def-1", 1000);
    const second = guestBonusEventId("ep-1", "def-1", 1000);
    expect(first).toBe(second);
    expect(first).toBe("podcast:bonus:ep-1:def-1:1000");
  });

  it("distinguishes distinct crossings", () => {
    expect(guestBonusEventId("ep-1", "def-1", 1000)).not.toBe(
      guestBonusEventId("ep-1", "def-1", 2000),
    );
    expect(guestBonusEventId("ep-1", "def-1", 1000)).not.toBe(
      guestBonusEventId("ep-2", "def-1", 1000),
    );
  });
});

describe("podcastEpisodeIdOfQueueRow — the payload is the source of truth", () => {
  it("reads the episode id back out of a queue row payload", () => {
    const payload = JSON.stringify({ podcast: { episode_id: "ep-42" } });
    expect(podcastEpisodeIdOfQueueRow(payload)).toBe("ep-42");
  });

  it("returns null for non-podcast and corrupt payloads — under-count, never over-pay", () => {
    expect(podcastEpisodeIdOfQueueRow(JSON.stringify({ profile: "distrokid_csv" }))).toBeNull();
    expect(podcastEpisodeIdOfQueueRow("not json at all")).toBeNull();
    expect(podcastEpisodeIdOfQueueRow("")).toBeNull();
  });
});

describe("validateGuestBonusDefinition — the bonus registration gate", () => {
  const VALID = {
    guest_payee_id: "payee_guest",
    guest_payee_name: "The Guest",
    milestone_kind: "downloads" as const,
    threshold: 1000,
    bonus_amount_cents: 500,
    currency: "USD",
  };

  it("accepts a valid definition", () => {
    expect(validateGuestBonusDefinition(VALID)).toMatchObject({ ok: true });
  });

  it("refuses an unknown milestone kind", () => {
    const validated = validateGuestBonusDefinition({
      ...VALID,
      milestone_kind: "streams" as never,
    });
    expect(validated).toMatchObject({ ok: false });
  });

  it("refuses a float threshold or float bonus — integers, never rounded", () => {
    expect(validateGuestBonusDefinition({ ...VALID, threshold: 999.5 })).toMatchObject({ ok: false });
    expect(validateGuestBonusDefinition({ ...VALID, bonus_amount_cents: 0.5 })).toMatchObject({ ok: false });
  });

  it("refuses a non-alpha-3 currency", () => {
    expect(validateGuestBonusDefinition({ ...VALID, currency: "usd" })).toMatchObject({ ok: false });
    expect(validateGuestBonusDefinition({ ...VALID, currency: "DOLLARS" })).toMatchObject({ ok: false });
  });

  it("refuses the reserved ledger payees", () => {
    expect(
      validateGuestBonusDefinition({ ...VALID, guest_payee_id: UNCLAIMED_HOLDING_PAYEE_ID }),
    ).toMatchObject({ ok: false });
  });
});

describe("bpsToPercent — exact rendering for refusal messages", () => {
  it("renders whole and fractional bps as a decimal percent", () => {
    expect(bpsToPercent(10000)).toBe("100.00");
    expect(bpsToPercent(9999)).toBe("99.99");
    expect(bpsToPercent(10001)).toBe("100.01");
  });
});

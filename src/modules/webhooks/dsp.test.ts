import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { dspWebhookEventId, ingestDspWebhook } from "./dsp";

/**
 * Ported from EmeraldVal PR #41 src/modules/webhooks/dsp.test.ts (head
 * c754bb4): SqliteStore(":memory:") swapped for the repo's InMemoryStore
 * injection pattern, and Store reads awaited against the async contract.
 * Assertions and coverage are unchanged.
 */

const LINE_ITEMS = [
  {
    work_id: "trk_01",
    work_title: "Midnight On 6th",
    amount_cents: 10_000,
    splits: [
      {
        payee_id: "c1",
        payee_name: "Yeshua Throne",
        role: "creator" as const,
        share_bps: 7000,
      },
      {
        payee_id: "l1",
        payee_name: "Throne Records",
        role: "label" as const,
        share_bps: 3000,
      },
    ],
  },
];

describe("ingestDspWebhook", () => {
  it("auto-triggers a UDR split on royalty.report and is idempotent", async () => {
    const store = new InMemoryStore();
    const first = await ingestDspWebhook(store, {
      event: "royalty.report",
      event_id: "evt_report_1",
      source: "spotify",
      period: "2026-08",
      line_items: LINE_ITEMS,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || !("split" in first) || first.split === undefined) {
      return;
    }
    expect(first.split.split_run.gross_cents).toBe(10_000);
    expect((await store.getVault("c1"))?.pending_balance).toBe(5320);
    expect((await store.getVault("c1"))?.reserve_balance).toBe(1680);
    const replay = await ingestDspWebhook(store, {
      event: "royalty.report",
      event_id: "evt_report_1",
      source: "spotify",
      line_items: LINE_ITEMS,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) {
      return;
    }
    expect(replay.idempotent).toBe(true);
    expect(await store.listGlJournals()).toHaveLength(1);
  });

  it("treats royalty.adjusted as another ingest", async () => {
    const store = new InMemoryStore();
    const result = await ingestDspWebhook(store, {
      event: "royalty.adjusted",
      source: "apple",
      period: "2026-09",
      line_items: LINE_ITEMS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !("split" in result) || result.split === undefined) {
      return;
    }
    expect(result.event.source).toBe("apple");
    expect(result.split.split_run.source).toBe("apple");
  });

  it("reverses a prior split on royalty.reversed", async () => {
    const store = new InMemoryStore();
    const reported = await ingestDspWebhook(store, {
      event: "royalty.report",
      event_id: "evt_r",
      source: "spotify",
      line_items: LINE_ITEMS,
    });
    expect(reported.ok).toBe(true);
    if (!reported.ok || !("split" in reported) || reported.split === undefined) {
      return;
    }
    const reversed = await ingestDspWebhook(store, {
      event: "royalty.reversed",
      event_id: "evt_rev",
      source: "spotify",
      split_run_id: reported.split.split_run.id,
    });
    expect(reversed.ok).toBe(true);
    if (!reversed.ok || !("split_run" in reversed) || reversed.split_run === undefined) {
      return;
    }
    expect(reversed.split_run.status).toBe("reversed");
    expect((await store.getVault("c1"))?.pending_balance).toBe(0);
    expect((await store.getVault("c1"))?.reserve_balance).toBe(0);
  });

  it("requires split_run_id on royalty.reversed", async () => {
    const store = new InMemoryStore();
    const result = await ingestDspWebhook(store, {
      event: "royalty.reversed",
      source: "spotify",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("missing_split_run_id");
    const blank = await ingestDspWebhook(store, {
      event: "royalty.reversed",
      source: "spotify",
      split_run_id: "   ",
    });
    expect(blank.ok).toBe(false);
  });

  it("propagates split calculate and reverse failures", async () => {
    const store = new InMemoryStore();
    const missingItems = await ingestDspWebhook(store, {
      event: "royalty.report",
      source: "spotify",
    });
    expect(missingItems.ok).toBe(false);

    const unbalanced = await ingestDspWebhook(store, {
      event: "royalty.report",
      source: "spotify",
      line_items: [
        {
          work_id: "trk_01",
          work_title: "Midnight",
          amount_cents: 100,
          splits: [
            {
              payee_id: "c1",
              payee_name: "Yeshua Throne",
              role: "creator",
              share_bps: 1,
            },
          ],
        },
      ],
    });
    expect(unbalanced.ok).toBe(false);

    const withRail = await ingestDspWebhook(store, {
      event: "royalty.report",
      source: "tidal",
      currency: "USD",
      rail: "ach",
      line_items: LINE_ITEMS,
    });
    expect(withRail.ok).toBe(true);

    const missing = await ingestDspWebhook(store, {
      event: "royalty.reversed",
      source: "spotify",
      split_run_id: "missing",
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      return;
    }
    expect(missing.code).toBe("split_run_not_found");
  });

  it("derives a stable event id when none is provided", () => {
    expect(
      dspWebhookEventId({
        event: "royalty.report",
        source: "spotify",
        period: "2026-08",
        line_items: [],
      }),
    ).toContain("spotify:royalty.report:2026-08");
    expect(
      dspWebhookEventId({
        event: "royalty.reversed",
        event_id: "  custom  ",
        source: "spotify",
      }),
    ).toBe("custom");
  });
});

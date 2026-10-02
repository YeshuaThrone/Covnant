/**
 * Merch queue writer + posting pass (PR 22, founder merchandise directive)
 * — the match_queue seam and the COGS-aware holding post, on the
 * in-memory store.
 *
 * Pinned here: the four content-derived event-id spaces (per order+sku,
 * per platform+order+sku, per payout id, per sale+sku), the replay guard's
 * counted no-ops, the DTC net-realized-profit equation to the cent (the
 * designer royalty is a PER-UNIT rate), the POD printing-before-split
 * discipline, the consignment reconciliation (shrinkage offsets the net
 * payout), the POS net, and the fail-closed dispositions — negative nets
 * and sub-cent rows stay in their queue rows, never posted, never rounded
 * up into invented money.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";

import { CanonicalPostingError } from "../posting";
import { postMerchNetsToHolding } from "../merchPosting";
import { writeMerchLinesToMatchQueue } from "../merchQueue";
import { dispatchStatementProfile } from "../profiles";
import type { VaultLookup } from "../matchQueue";
import { loadFixture } from "./fixtures";

const NOW = new Date("2026-09-30T12:00:00Z");

/** Every matched UPC resolves to its verified vault product. */
function vaultWithUpcs(): VaultLookup {
  const catalog: Record<string, string> = {
    "012345678901": "CBT-MERCH-TEE",
    "023456789012": "CBT-MERCH-POD",
    "045678901234": "CBT-MERCH-TOTE",
    "056789012345": "CBT-MERCH-LP",
    "067890123456": "CBT-MERCH-STICKER",
    "078901234567": "CBT-MERCH-HOODIE",
  };
  return {
    async findByIdentifier(kind, value) {
      const cbt = kind === "UPC" ? catalog[value] : undefined;
      if (cbt === undefined) return null;
      return {
        cvtCode: "CVT-MERCH",
        cbtCode: cbt,
        title: "Covenant Product",
        medium: "merchandise",
        externalIdentifiers: { UPC: value },
        holderUct: null,
      };
    },
  };
}

/** Parses + writes one fixture dump through the real writer. */
async function ingestFixture(store: Store, fixture: string) {
  const profile = dispatchStatementProfile(loadFixture(fixture));
  if (profile === null) throw new Error(`fixture ${fixture} failed to dispatch`);
  const lines = profile.parse(loadFixture(fixture));
  return {
    profile,
    counts: await writeMerchLinesToMatchQueue(
      store,
      `ingest-${fixture}`,
      lines,
      vaultWithUpcs(),
    ),
  };
}

describe("the match_queue writer", () => {
  it("writes every DTC row into its content-derived event-id space", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "merch_shopify_dtc.csv");
    expect(counts.written).toBe(4);
    expect(counts.alreadyPresent).toBe(0);
    expect(counts.matched).toBe(3); // rows 1–3 share the verified UPC
    expect(counts.unmatched).toBe(1); // row 4's UPC is not in the vault
    for (const outcome of counts.lineOutcomes) {
      expect(outcome.eventId).toMatch(/^merch:dtc:[0-9a-f]{64}$/);
    }
    expect(counts.alreadyPresent).toBe(0); // every row was a fresh insert
  });

  it("computes the DTC net realized profit equation to the cent", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "merch_shopify_dtc.csv");
    // Row 1: $56.00 − COGS (2 × $6.50) − $4.99 shipping − $1.20
    // fulfillment − $1.68 gateway − royalty (2 × $3.50) = $28.13.
    const row1 = counts.lineOutcomes[0]!;
    expect(row1.disposition).toBe("money");
    expect(row1.netCents).toBe(2_813);
    expect(row1.deductionMicros).toBe("2787000000");
    expect(row1.matchedCbtCode).toBe("CBT-MERCH-TEE");
  });

  it("records the pass's production COGS — the FIFO engine's debt-side input", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "merch_shopify_dtc.csv");
    // All four rows: (2 × $6.50) + (1 × $0.25) + (1 × $25.00) + (1 × $5.00)
    // = $43.25 — the queue row records its COGS whether or not the vault
    // match lands or the net ever posts (the FIFO engine's debt-side input).
    expect(counts.cogsMicrosDeducted).toBe(4_325_000_000n);
  });

  it("parks a sub-cent net in the zero_net disposition — never rounded up", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "merch_shopify_dtc.csv");
    // Row 2: $1.00 − $0.25 COGS − $0.746 gateway = $0.004 — four tenths of
    // a cent. The queue row records it; the ledger never sees it.
    const row2 = counts.lineOutcomes[1]!;
    expect(row2.disposition).toBe("zero_net");
    expect(row2.netCents).toBe(0);
  });

  it("parks a negative net in the held quarantine — never a negative credit", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "merch_shopify_dtc.csv");
    // Row 3: $10.00 gross against $25.00 COGS — the cost legs outran the
    // gross. Visible, auditable, never posted.
    const row3 = counts.lineOutcomes[2]!;
    expect(row3.disposition).toBe("held_negative_net");
    expect(row3.netCents).toBe(0);
    expect(counts.heldNegativeNet).toBe(1);
  });

  it("computes the POD split share of the AFTER-printing remainder", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "merch_pod_fulfillment.csv");
    expect(counts.matched).toBe(2);
    expect(counts.unmatched).toBe(1);
    // Row 1: $30.00 − $9.50 printing = $20.50; 50% of that — never of the
    // gross — is $10.25.
    const row1 = counts.lineOutcomes[0]!;
    expect(row1.disposition).toBe("money");
    expect(row1.netCents).toBe(1_025);
    // Row 2: $17.99 − $6.25 = $11.74; 33.33% of that is $3.912942 → the
    // recon lane floors to 391¢ (the residue never rounds up).
    const row2 = counts.lineOutcomes[1]!;
    expect(row2.disposition).toBe("money");
    expect(row2.netCents).toBe(391);
    // All three rows: $9.50 + $6.25 + $8.00 = $23.75 of recorded printing
    // cost (the unmatched row's cost is still recorded on its queue row).
    expect(counts.cogsMicrosDeducted).toBe(2_375_000_000n);
  });

  it("records the consignment shrinkage allowance that offset the payout", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "merch_wholesale_consignment.csv");
    expect(counts.written).toBe(2);
    expect(counts.matched).toBe(2);
    // Row 1 posts its reconciled net payout ($74.25); the $2.25 shrinkage
    // allowance is the offset the reconciliation already priced.
    const row1 = counts.lineOutcomes[0]!;
    expect(row1.netCents).toBe(7_425);
    expect(row1.shrinkageOffsetMicros).toBe("225000000");
    expect(counts.shrinkageOffsetMicros).toBe(225_000_000n);
    const row2 = counts.lineOutcomes[1]!;
    expect(row2.netCents).toBe(2_040);
    expect(row2.shrinkageOffsetMicros).toBe("0");
  });

  it("computes the POS net — gross minus the processing fee", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "merch_square_pos.csv");
    expect(counts.written).toBe(2);
    expect(counts.lineOutcomes[0]!.netCents).toBe(754); // $8.00 − $0.46
    expect(counts.lineOutcomes[1]!.netCents).toBe(5_226); // $54.00 − $1.74
  });

  it("skips vault lookups entirely when no vault is wired — and says so", async () => {
    const store = new InMemoryStore();
    const profile = dispatchStatementProfile(loadFixture("merch_shopify_dtc.csv"));
    if (profile === null) throw new Error("fixture failed to dispatch");
    const counts = await writeMerchLinesToMatchQueue(
      store,
      "ingest-novault",
      profile.parse(loadFixture("merch_shopify_dtc.csv")),
      null,
    );
    expect(counts.matched).toBe(0);
    expect(counts.unmatched).toBe(4);
    expect(counts.written).toBe(4); // rows exist, honestly unmatched
  });

  it("replays as counted no-ops — the unique event_id is the dedup seam", async () => {
    const store = new InMemoryStore();
    await ingestFixture(store, "merch_pod_fulfillment.csv");
    const { counts: replay } = await ingestFixture(store, "merch_pod_fulfillment.csv");
    expect(replay.written).toBe(0);
    expect(replay.alreadyPresent).toBe(3);
    expect(replay.matched).toBe(2); // the vault lookup still runs
  });
});

describe("the posting pass", () => {
  it("posts postable DTC nets and leaves quarantined rows in their queue rows", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "merch_shopify_dtc.csv");
    const posting = await postMerchNetsToHolding(store, counts, NOW);
    // Row 1 posts $28.13. Row 2 (sub-cent), row 3 (negative), and row 4
    // (unmatched) stay quarantined — never posted, never rounded up.
    expect(posting.posted).toBe(1);
    expect(posting.alreadyPosted).toBe(0);
    expect(posting.heldNegativeNet).toBe(1);
    expect(posting.zeroNet).toBe(1);
    expect(posting.unmatched).toBe(1);

    const credits = await store.listUnclaimedHoldingCredits(100);
    expect(credits.map((c) => c.amount_cents)).toEqual([2_813]);
  });

  it("posts the POD collaborator shares, the consignment nets, and the POS nets", async () => {
    const store = new InMemoryStore();
    const pod = await ingestFixture(store, "merch_pod_fulfillment.csv");
    const podPosting = await postMerchNetsToHolding(store, pod.counts, NOW);
    expect(podPosting.posted).toBe(2); // rows 1–2; row 3 is unmatched

    const consignment = await ingestFixture(store, "merch_wholesale_consignment.csv");
    const consignmentPosting = await postMerchNetsToHolding(store, consignment.counts, NOW);
    expect(consignmentPosting.posted).toBe(2);

    const pos = await ingestFixture(store, "merch_square_pos.csv");
    const posPosting = await postMerchNetsToHolding(store, pos.counts, NOW);
    expect(posPosting.posted).toBe(2);

    const credits = (await store.listUnclaimedHoldingCredits(100)).map((c) => c.amount_cents);
    expect(credits.sort((a, b) => a - b)).toEqual([
      391, 754, 1_025, 2_040, 5_226, 7_425,
    ]);
  });

  it("replays as counted no-ops — a re-shipped dump never double-posts", async () => {
    const store = new InMemoryStore();
    const first = await ingestFixture(store, "merch_wholesale_consignment.csv");
    await postMerchNetsToHolding(store, first.counts, NOW);
    const replay = await ingestFixture(store, "merch_wholesale_consignment.csv");
    const replayPosting = await postMerchNetsToHolding(store, replay.counts, NOW);
    expect(replayPosting.posted).toBe(0);
    expect(replayPosting.alreadyPosted).toBe(2);
    expect((await store.listUnclaimedHoldingCredits(100)).length).toBe(2);
  });

  it("fails closed when the ledger store throws — the queue row stays the quarantine record", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "merch_shopify_dtc.csv");
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
    await expect(postMerchNetsToHolding(broken, counts, NOW)).rejects.toThrow(
      CanonicalPostingError,
    );
    await expect(postMerchNetsToHolding(broken, counts, NOW)).rejects.toThrow(
      /ledger_store_error/,
    );
    // The queue rows survived the failed pass — the retry heals them
    // idempotently through the per-source replay guard.
    expect((await store.listUnclaimedHoldingCredits(100)).length).toBe(0);
  });
});

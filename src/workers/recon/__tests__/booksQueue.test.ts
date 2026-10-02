// Book lane queue-writer tests (PR 26) — the match_queue seam the same way
// podcastQueue.test.ts pins the podcast seam: the vault's ISBN cross-
// reference (the lane's lookup priority — the book writer performs its OWN
// direct ISBN lookup), the addendum 9 columns carried on the queue row
// (isbn, format_type, cogs_per_unit_micros, platform_commission_micros),
// the write-time POD/agency nets, the negative-net quarantine, the sub-cent
// zero, and the replay guard's counted no-ops.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { VaultLookup } from "../matchQueue";
import { writeBookLinesToMatchQueue } from "../booksQueue";
import {
  podPrintDeductionMicros,
  podPrintNetRoyaltyMicros,
} from "../books";
import { microsToWholeCents } from "../posting";
import type { BookLineDetail } from "../records";
import type { ParsedStatementLine } from "../records";

const ISBN = "9781612198300";

/** The vault resolves this ISBN and records the kinds it was asked for. */
function vaultWithIsbn(): VaultLookup & { askedKinds: Array<[string, string]> } {
  const askedKinds: Array<[string, string]> = [];
  return {
    askedKinds,
    async findByIdentifier(kind, value) {
      askedKinds.push([kind, value]);
      if (kind === "ISBN" && value === ISBN) {
        return {
          cvtCode: "CVT-TEST-BOOK",
          cbtCode: "CBT-TEST-BOOK",
          title: "Covenant Test Book",
          medium: "book",
          externalIdentifiers: { ISBN: value },
          holderUct: null,
        };
      }
      return null;
    },
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
    identifiers: { ISBN },
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

const audioDetail: Extract<BookLineDetail, { kind: "audiobook_sale" }> = {
  kind: "audiobook_sale",
  platform: "amazon_kdp",
  isbn: ISBN,
  orderId: "ord-003",
  units: 1,
  royaltyPerUnitMicros: "450000000",
  grossMicros: "450000000",
  period: "2026-10",
};

const magIssueDetail: Extract<BookLineDetail, { kind: "magazine_issue" }> = {
  kind: "magazine_issue",
  platform: "zinio",
  magazineId: "mag-atlas-monthly",
  issueId: "iss-2026-10",
  eventId: "zinio-issue-0001",
  units: 1,
  grossMicros: "500000000",
  period: "2026-10",
};

describe("writeBookLinesToMatchQueue", () => {
  it("cross-references the vault by ISBN kind — the lane's lookup priority", async () => {
    const store = new InMemoryStore();
    const vault = vaultWithIsbn();
    const counts = await writeBookLinesToMatchQueue(store, "ing-1", [
      bookLine(printDetail),
    ], vault);
    expect(counts.matched).toBe(1);
    expect(vault.askedKinds).toEqual([["ISBN", ISBN]]);
    expect(counts.lineOutcomes[0]?.matchedCbtCode).toBe("CBT-TEST-BOOK");
  });

  it("writes the print row with the POD equation's net and its recorded legs", async () => {
    const store = new InMemoryStore();
    const counts = await writeBookLinesToMatchQueue(store, "ing-1", [
      bookLine(printDetail),
    ], null);
    expect(counts.written).toBe(1);
    expect(counts.printDeductionMicros).toBe(podPrintDeductionMicros(printDetail));

    const outcome = counts.lineOutcomes[0]!;
    expect(outcome.disposition).toBe("money");
    // $10.00 retail − $2.31 print − $0.20 fee − 55% channel = $1.99 net.
    expect(outcome.netCents).toBe(microsToWholeCents(podPrintNetRoyaltyMicros(printDetail))); // 199 cents

    const rows = await store.listMatchQueueEntries();
    const row = rows[0]!;
    expect(row.event_id).toMatch(/^book:print:/);
    expect(row.isbn).toBe(ISBN);
    expect(row.format_type).toBe("print");
    expect(row.cogs_per_unit_micros).toBe("231000000");
    expect(row.platform_commission_micros).toBe(
      podPrintDeductionMicros(printDetail).toString(),
    );
  });

  it("writes the e-book row with the agency royalty net and no publication format", async () => {
    const store = new InMemoryStore();
    const counts = await writeBookLinesToMatchQueue(store, "ing-1", [
      bookLine(ebookDetail),
    ], null);
    const outcome = counts.lineOutcomes[0]!;
    // 9.99 is inside the tier: 70% of 999 cents is 699 cents ($6.99).
    expect(outcome.netCents).toBe(699);
    expect(outcome.deductionMicros).toBe("299700000");

    const rows = await store.listMatchQueueEntries();
    expect(rows[0]?.format_type).toBeNull();
    expect(rows[0]?.isbn).toBe(ISBN);
  });

  it("writes the audiobook row as 'audio' and the magazine row without an isbn", async () => {
    const store = new InMemoryStore();
    const counts = await writeBookLinesToMatchQueue(store, "ing-1", [
      bookLine(audioDetail),
      bookLine(magIssueDetail),
    ], null);
    const rows = await store.listMatchQueueEntries();
    expect(counts.written).toBe(2);
    const audio = rows.find((r) => r.event_id.startsWith("book:audio:"));
    const mag = rows.find((r) => r.event_id.startsWith("book:magazine:"));
    expect(audio?.format_type).toBe("audio");
    expect(audio?.platform_commission_micros).toBe("0"); // no agency tier
    expect(mag?.isbn).toBeNull();
    expect(mag?.format_type).toBeNull();
  });

  it("keeps an unmatched ISBN honestly unmatched — the row never posts", async () => {
    const store = new InMemoryStore();
    const counts = await writeBookLinesToMatchQueue(store, "ing-1", [
      bookLine(printDetail, { identifiers: {} }),
    ], vaultWithIsbn());
    expect(counts.matched).toBe(0);
    expect(counts.unmatched).toBe(1);
    expect(counts.lineOutcomes[0]?.matchedCbtCode).toBeNull();
  });

  it("quarantines a negative-net print row — written, never posted", async () => {
    const store = new InMemoryStore();
    const losingDetail: Extract<BookLineDetail, { kind: "print_sale" }> = {
      ...printDetail,
      grossRetailMicros: "300000000", // 3,000 cents retail...
      printingCostPerUnitMicros: "800000000", // ...8,000 cents to print
    };
    const counts = await writeBookLinesToMatchQueue(store, "ing-1", [
      bookLine(losingDetail),
    ], null);
    expect(counts.heldNegativeNet).toBe(1);
    expect(counts.lineOutcomes[0]?.disposition).toBe("held_negative_net");
    expect(counts.lineOutcomes[0]?.netCents).toBe(0);
    // Visible on the queue with the full recorded deduction.
    const rows = await store.listMatchQueueEntries();
    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0]?.platform_commission_micros as string)).toBeGreaterThan(0n);
  });

  it("counts a re-shipped report as replay no-ops — never double rows", async () => {
    const store = new InMemoryStore();
    const lines = [bookLine(printDetail), bookLine(ebookDetail)];
    const first = await writeBookLinesToMatchQueue(store, "ing-1", lines, null);
    expect(first.written).toBe(2);
    expect(first.alreadyPresent).toBe(0);

    const replay = await writeBookLinesToMatchQueue(store, "ing-2", lines, null);
    expect(replay.written).toBe(0);
    expect(replay.alreadyPresent).toBe(2);
  });
});

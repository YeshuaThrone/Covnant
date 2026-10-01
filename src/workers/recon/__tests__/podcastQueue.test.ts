/**
 * Podcast queue writer + posting pass (PR 10) — the match_queue seam and
 * the commission-aware holding post, on the in-memory store.
 *
 * Pinned here: the three event-id spaces at the store boundary (countable
 * impressions, the held-sponsor quarantine, per-ingest subscriptions), the
 * replay guard's counted no-ops, the commission recorded at write time,
 * the sub-cent quarantine (never rounded up into invented money), and the
 * fail-closed store-error path.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";

import { CanonicalPostingError } from "../posting";
import { postPodcastLinesToHolding } from "../podcastPosting";
import { writePodcastLinesToMatchQueue, isPodcastHeldLine } from "../podcastQueue";
import { qualifyImpressionLines } from "../podcast";
import { dispatchStatementProfile } from "../profiles";
import type { VaultLookup } from "../matchQueue";
import { loadFixture } from "./fixtures";

const NOW = new Date("2026-09-30T12:00:00Z");

/** Every show DOI in the fixtures resolves to the verified vault show. */
function vaultWithDoi(): VaultLookup {
  return {
    async findByIdentifier(kind, value) {
      if (kind === "DOI" && value === "10.61982/covenant.show-001") {
        return {
          cvtCode: "CVT-TEST-SHOW",
          cbtCode: "CBT-POD-SHOW-001",
          title: "Covenant Show 001",
          medium: "podcast",
          externalIdentifiers: { DOI: value },
          holderUct: null,
        };
      }
      return null;
    },
  };
}

/** Parses + qualifies + writes one fixture log through the real writer. */
async function ingestFixture(store: Store, fixture: string) {
  const profile = dispatchStatementProfile(loadFixture(fixture));
  if (profile === null) throw new Error(`fixture ${fixture} failed to dispatch`);
  const ingest = await store.insertStatementIngest({
    format: fixture === "podcast_dai_log.csv" ? "dai_log" : "rss_report",
    source: "statement",
    file_name: fixture,
    content: loadFixture(fixture),
    status: "parsed",
    event_count: null,
    error: null,
    created_at: NOW.toISOString(),
  });
  await store.createReconJob({ source: "statement", ingest_id: ingest.id });
  const lines = profile.parse(loadFixture(fixture));
  const qualification = qualifyImpressionLines(lines);
  const writable = [
    ...qualification.qualified,
    ...lines.filter(
      (line) => line.podcastDetail?.revenueChannel === "channel_c_subscription",
    ),
  ];
  return {
    ingest,
    qualification,
    counts: await writePodcastLinesToMatchQueue(
      store,
      ingest.id,
      writable,
      vaultWithDoi(),
    ),
  };
}

describe("the match_queue writer", () => {
  it("writes every qualified DAI impression with its fingerprint event id", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "podcast_dai_log.csv");
    expect(counts.written).toBe(8);
    expect(counts.alreadyPresent).toBe(0);
    expect(counts.heldWritten).toBe(0);
    expect(counts.matched).toBe(8);
    expect(counts.unmatched).toBe(0);
    for (const outcome of counts.lineOutcomes) {
      expect(outcome.eventId).toMatch(/^podcast:imp:[0-9a-f]{64}$/);
      expect(outcome.written).toBe(true);
      expect(outcome.matchedCbtCode).toBe("CBT-POD-SHOW-001");
    }
  });

  it("records the commission at write time from the row's own facts", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "podcast_dai_log.csv");
    // Row 1: $12 CPM × 1 impression = $0.012 gross (1,200,000 units at
    // 1e-8 dollars); 4000 bps of that is 480,000 units ($0.0048) — the
    // queue row is the source of truth the posting pass reads.
    const row1 = counts.lineOutcomes[0]!;
    expect(row1.commissionMicros).toBe("480000");
    // Row 3 is direct-sold ($15 CPM → 1,500,000 units): zero commission
    // even though it posts.
    const row3 = counts.lineOutcomes.find(
      (o) => o.line.grossMicros === 1_500_000n,
    );
    expect(row3?.commissionMicros).toBe("0");
  });

  it("parks the unverified host read in the held quarantine space", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "podcast_rss_report.csv");
    expect(counts.heldWritten).toBe(1);
    const held = counts.lineOutcomes.find((o) => isPodcastHeldLine(o.line));
    expect(held?.eventId).toMatch(/^podcast:held:[0-9a-f]{64}$/);
    expect(held?.written).toBe(true); // visible — but never counted, never posted
  });

  it("writes the subscription row into the per-ingest id space", async () => {
    const store = new InMemoryStore();
    const { ingest, counts } = await ingestFixture(store, "podcast_rss_report.csv");
    const sub = counts.lineOutcomes.find(
      (o) => o.line.podcastDetail?.revenueChannel === "channel_c_subscription",
    );
    expect(sub?.eventId).toBe(`podcast:sub:${ingest.id}:line:3`);
  });

  it("replays as counted no-ops — the unique event_id is the dedup seam", async () => {
    const store = new InMemoryStore();
    await ingestFixture(store, "podcast_dai_log.csv");
    const { counts: replay } = await ingestFixture(store, "podcast_dai_log.csv");
    expect(replay.written).toBe(0);
    expect(replay.alreadyPresent).toBe(8);
  });

  it("dedupes the RSS cross-feed duplicate against the DAI log's anchor", async () => {
    const store = new InMemoryStore();
    await ingestFixture(store, "podcast_dai_log.csv");
    const { counts } = await ingestFixture(store, "podcast_rss_report.csv");
    // RSS rows 1, 2 (held), 3 (subscription), 4 write; row 7 collides with
    // the DAI log's row-1 fingerprint — the cross-feed dedup directive.
    expect(counts.written).toBe(4);
    expect(counts.alreadyPresent).toBe(1);
    const replayed = counts.lineOutcomes.find((o) => !o.written);
    expect(replayed?.eventId).toMatch(/^podcast:imp:[0-9a-f]{64}$/);
  });

  it("skips vault lookups entirely when no vault is wired — and says so", async () => {
    const store = new InMemoryStore();
    const profile = dispatchStatementProfile(loadFixture("podcast_dai_log.csv"));
    if (profile === null) throw new Error("fixture failed to dispatch");
    const lines = profile.parse(loadFixture("podcast_dai_log.csv"));
    const qualification = qualifyImpressionLines(lines);
    const counts = await writePodcastLinesToMatchQueue(
      store,
      "ingest-x",
      qualification.qualified,
      null,
    );
    expect(counts.matched).toBe(0);
    expect(counts.unmatched).toBe(8);
    expect(counts.written).toBe(8); // rows exist, honestly unmatched
  });
});

describe("the posting pass", () => {
  it("posts creator net in whole cents and quarantines sub-cent rows", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "podcast_dai_log.csv");
    const posting = await postPodcastLinesToHolding(
      store,
      counts.lineOutcomes,
      NOW,
    );
    // Row 3: 1,500,000 units net $0.015 → floor 1¢. Row 12 (host read):
    // 3,000,000 units → 3¢. Everything else nets sub-cent and stays in its
    // queue row — never rounded up into invented money.
    expect(posting.posted).toBe(2);
    expect(posting.alreadyPosted).toBe(0);
    expect(posting.commissionMicrosDeducted).toBe(0n); // both posts are commission-free

    const credits = await store.listUnclaimedHoldingCredits(100);
    expect(credits.map((c) => c.amount_cents).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it("never posts held or unmatched lines", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "podcast_rss_report.csv");
    const posting = await postPodcastLinesToHolding(
      store,
      counts.lineOutcomes,
      NOW,
    );
    // Postable: row 1 (25,000,000,000 units → 25,000¢), row 3
    // (subscription 499,000,000 units → 499¢), row 4 (1,000,000 units → 1¢),
    // row 7 (1,200,000 units → 1¢). Row 2 is held and never posts. This
    // store has no DAI pass, so row 7 is the FIRST report of its impression
    // and posts; the cross-feed replay refusal (DAI first, RSS second) is
    // covered in podcastParity.test.ts.
    expect(posting.posted).toBe(4);
    expect(posting.alreadyPosted).toBe(0);
    expect(posting.commissionMicrosDeducted).toBe(0n); // Channel B bypasses network commission

    const cents = (await store.listUnclaimedHoldingCredits(100))
      .map((c) => c.amount_cents)
      .sort((a, b) => a - b);
    expect(cents).toEqual([1, 1, 499, 25000]);
  });

  it("replays the whole pass as counted no-ops", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "podcast_dai_log.csv");
    await postPodcastLinesToHolding(store, counts.lineOutcomes, NOW);
    const before = (await store.listUnclaimedHoldingCredits(100)).length;

    // A replayed ingest re-writes nothing (queue guard) and re-posts
    // nothing (the posting pass never resurrects a refused write) — the
    // same counted-no-op shape the music lane rides.
    const { counts: replayCounts } = await ingestFixture(store, "podcast_dai_log.csv");
    const replayPosting = await postPodcastLinesToHolding(
      store,
      replayCounts.lineOutcomes,
      NOW,
    );
    expect(replayCounts.written).toBe(0);
    expect(replayPosting.posted).toBe(0);
    expect(replayPosting.alreadyPosted).toBe(0); // refused writes never reach the journal guard
    expect((await store.listUnclaimedHoldingCredits(100)).length).toBe(before);
  });

  it("fails closed when the ledger store cannot accept the post", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "podcast_dai_log.csv");
    // The posting seam treats ANY non-replay store failure as terminal —
    // never swallowed, never retried inside the pass.
    const broken = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "insertLedgerTransaction") {
          return async () => {
            throw new Error("ledger store unavailable");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;
    await expect(
      postPodcastLinesToHolding(broken, counts.lineOutcomes, NOW),
    ).rejects.toBeInstanceOf(CanonicalPostingError);
  });
});

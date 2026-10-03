// The INSTANT tool-call micro-settlements (PR 45) — the behavioral suite
// for the founder's software directive: a detected agent tool-call event
// prices through the PR 44 split economics and posts THE MOMENT the walk
// reaches it — the builder's share lands in their vault through the taxed
// cascade, the platform's share lands in the platform variance account,
// and one balanced journal rides the posting. The replay guard is the
// content-derived event id (a re-shipped event is a counted no-op, never a
// second posting); the pricing terms come from the policy of record — no
// policy, no settlement, never a guessed rate. Builder share + platform
// share === the settlement pot, ALWAYS, in exact integer cents.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import { COMPANY_VARIANCE_PAYEE_ID } from "@/modules/don/constants";
import {
  postInstantToolCallSettlement,
} from "@/lib/server/developerToolCallSettlements";
import { agentToolCallSplit } from "@/workers/recon/developer";

const T0 = new Date("2026-10-03T12:00:00.000Z");

function makeStore(): Store {
  return new InMemoryStore();
}

/** A verified TIN/W-9 profile — the no-backup-withholding state of record. */
async function seedVerifiedTaxProfile(store: Store, creatorId: string): Promise<void> {
  await store.upsertCreatorTaxProfile({
    creator_id: creatorId,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: T0.toISOString(),
  });
}

async function seedWebSearchPolicy(
  store: Store,
  builderPayeeId = "tool-builder-scout",
  microsPerCall = 400_000,
  builderShareBps = 9_500,
): Promise<void> {
  await store.upsertDeveloperToolPolicy({
    tool_id: "web_search",
    builder_payee_id: builderPayeeId,
    micros_per_call: microsPerCall,
    builder_share_bps: builderShareBps,
  });
}

const BASE_EVENT = {
  source_event_id: "atc-2026-10-03-0001",
  agent_id: "agent-scout-7",
  tool_id: "web_search" as const,
  call_count: 1_200,
  period: "2026-10",
  currency: "USD",
};

/** The payee's total vault balance across all buckets. */
async function vaultTotal(store: Store, payeeId: string): Promise<number> {
  const vault = await store.getVault(payeeId);
  if (vault === undefined) return 0;
  return vault.available_balance + vault.pending_balance + vault.reserve_balance;
}

function expectFailure(
  result: { ok: false; code: string } | { ok: true },
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    expect.unreachable("expected a failure result");
  }
  expect(result.code).toBe(code);
}

describe("postInstantToolCallSettlement — the per-event instant post", () => {
  it("prices through the PR 44 split and posts immediately: builder ledger + platform share + one balanced journal", async () => {
    const store = makeStore();
    await seedVerifiedTaxProfile(store, "tool-builder-scout");
    await seedWebSearchPolicy(store);

    const before = await vaultTotal(store, "tool-builder-scout");
    const platformBefore = await vaultTotal(store, COMPANY_VARIANCE_PAYEE_ID);

    const settled = await postInstantToolCallSettlement(store, BASE_EVENT, T0);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    // The split is the PR 44 economics exactly: 1200 calls × 400,000
    // micros = 480 cents; the builder's 95% floors to 456, platform 24.
    expect(settled.value.settlement_cents).toBe(480);
    expect(settled.value.builder_cents).toBe(456);
    expect(settled.value.platform_cents).toBe(24);
    expect(settled.value.replayed).toBe(false);
    expect(settled.value.journal_id).not.toBeNull();

    // The application row of record carries the split and the policy ref.
    const row = await store.getDeveloperToolCallApplication(BASE_EVENT.source_event_id);
    expect(row).toBeDefined();
    expect(row?.builder_cents).toBe(456);
    expect(row?.platform_cents).toBe(24);
    expect(row?.settlement_cents).toBe(480);
    expect(row?.builder_payee_id).toBe("tool-builder-scout");

    // The builder's share LANDED in their vault (verified TIN, no YTD —
    // no withholding, no recoupment: the full share posts).
    const after = await vaultTotal(store, "tool-builder-scout");
    expect(after - before).toBe(456);

    // The platform's share landed in the platform variance account.
    const platformAfter = await vaultTotal(store, COMPANY_VARIANCE_PAYEE_ID);
    expect(platformAfter - platformBefore).toBe(24);

    // THE INVARIANT: builder + platform === pot, ALWAYS.
    expect(settled.value.builder_cents + settled.value.platform_cents).toBe(
      settled.value.settlement_cents,
    );
  });

  it("replays a re-shipped event as a counted no-op — no second row, no second posting, no vault movement", async () => {
    const store = makeStore();
    await seedVerifiedTaxProfile(store, "tool-builder-scout");
    await seedWebSearchPolicy(store);

    const first = await postInstantToolCallSettlement(store, BASE_EVENT, T0);
    expect(first.ok).toBe(true);

    const before = await vaultTotal(store, "tool-builder-scout");
    const platformBefore = await vaultTotal(store, COMPANY_VARIANCE_PAYEE_ID);

    const replayed = await postInstantToolCallSettlement(store, BASE_EVENT, T0);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.replayed).toBe(true);
    expect(replayed.value.journal_id).toBeNull();
    expect(replayed.value.builder_cents).toBe(456);

    // Nothing moved twice.
    expect((await vaultTotal(store, "tool-builder-scout")) - before).toBe(0);
    expect((await vaultTotal(store, COMPANY_VARIANCE_PAYEE_ID)) - platformBefore).toBe(0);
  });

  it("refuses a tool with no policy of record — fail-closed, never a guessed rate", async () => {
    const store = makeStore();
    await seedVerifiedTaxProfile(store, "tool-builder-scout");

    expectFailure(
      await postInstantToolCallSettlement(store, BASE_EVENT, T0),
      "tool_policy_missing",
    );
    // Nothing recorded, nothing posted.
    expect(await store.getDeveloperToolCallApplication(BASE_EVENT.source_event_id)).toBeUndefined();
  });

  it("records a sub-micro pot truthfully — the row of record exists, no journal, no vault movement", async () => {
    const store = makeStore();
    await seedVerifiedTaxProfile(store, "tool-builder-scout");
    // 1 micro/call × 1 call = 1 micro — floors to 0 payable cents.
    await seedWebSearchPolicy(store, "tool-builder-scout", 1, 9_500);

    const settled = await postInstantToolCallSettlement(store, {
      ...BASE_EVENT,
      call_count: 1,
    }, T0);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.settlement_cents).toBe(0);
    expect(settled.value.builder_cents).toBe(0);
    expect(settled.value.platform_cents).toBe(0);
    expect(settled.value.journal_id).toBeNull();

    const row = await store.getDeveloperToolCallApplication(BASE_EVENT.source_event_id);
    expect(row).toBeDefined();
    expect(row?.settlement_cents).toBe(0);
  });

  it("refuses a blank identity and a non-positive call count", async () => {
    const store = makeStore();
    expectFailure(
      await postInstantToolCallSettlement(store, { ...BASE_EVENT, source_event_id: "  " }, T0),
      "invalid_settlement_identity",
    );
    expectFailure(
      await postInstantToolCallSettlement(store, { ...BASE_EVENT, call_count: 0 }, T0),
      "invalid_settlement_calls",
    );
    expectFailure(
      await postInstantToolCallSettlement(store, { ...BASE_EVENT, call_count: 10.5 }, T0),
      "invalid_settlement_calls",
    );
  });

  it("prices multi-call batches through agentToolCallSplit exactly — the floor discipline", () => {
    const split = agentToolCallSplit({
      callCount: 800,
      microsPerCall: 200_000,
      builderShareBps: 9_000,
    });
    expect(split.settlementCents).toBe(160);
    expect(split.builderCents).toBe(144);
    expect(split.platformCents).toBe(16);
    expect(split.builderCents + split.platformCents).toBe(split.settlementCents);
  });
});

describe("the walk's instant postings — the detector's events settle on arrival", () => {
  it("counts the instant postings alongside the committed settlements", async () => {
    const store = makeStore();
    await seedVerifiedTaxProfile(store, "tool-builder-scout");
    await seedVerifiedTaxProfile(store, "tool-builder-quest");
    await seedWebSearchPolicy(store);
    await store.upsertDeveloperToolPolicy({
      tool_id: "database_query",
      builder_payee_id: "tool-builder-quest",
      micros_per_call: 200_000,
      builder_share_bps: 9_000,
    });

    const settled = await postInstantToolCallSettlement(store, BASE_EVENT, T0);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.journal_id).not.toBeNull();
    expect(settled.value.replayed).toBe(false);

    // A replayed event posts nothing new — the counted no-op.
    const replayed = await postInstantToolCallSettlement(store, BASE_EVENT, T0);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.replayed).toBe(true);
    expect(replayed.value.journal_id).toBeNull();
  });
});

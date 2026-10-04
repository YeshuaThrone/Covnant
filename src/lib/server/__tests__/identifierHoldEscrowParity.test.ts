/**
 * The identifier-hold escrow — THREE-BACKEND PARITY (the task's locked
 * bar).
 *
 * The identical hold → verify → release lifecycle runs against
 * InMemoryStore, SqliteStore (real better-sqlite3, :memory:), and
 * SupabaseStore over the behavioral PostgREST fake, and every backend must
 * produce the same observable outcome: the same escrow row shape (sentinel
 * payee, integer cents, the quarantined event in line_item_id), the same
 * per-source replay-guard refusal, the same CAS settlement semantics
 * (exactly one winner — the loser reads undefined), the same release rows
 * and journals. The escrow rides only Store-interface methods, so parity
 * is the PROOF that no backend drifts.
 *
 * The registry ping and the evidence store are the session-independent
 * seams (registryPing.ts / crossLinkEvidence.ts) — stubbed identically per
 * backend; they hold no per-backend state.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import { InMemoryCrossLinkEvidenceStore } from "@/lib/identifiers/crossLinkEvidence";
import type {
  RegistryPingClient,
  RegistryPingVerdict,
} from "@/lib/identifiers/registryPing";
import {
  identifierHoldEscrowScopeKey,
  pingRegistryToVerifyHeldIdentifier,
  postIdentifierHoldEscrow,
  releaseIdentifierHoldEscrow,
} from "@/lib/server/identifierHoldEscrow";
import { identifierHoldEscrowPayeeId } from "@/modules/don/constants";

import { makeFakeSupabaseStore } from "@/workers/recon/__tests__/fakeSupabase";

// ---------------------------------------------------------------------------
// Backend registry + the shared scenario.
// ---------------------------------------------------------------------------

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    name: "SupabaseStore",
    make: () => makeFakeSupabaseStore(),
  },
] as const;

const T0 = new Date("2026-10-04T12:00:00Z");
const EVENT = "recon:ing-7:line:11";
const AMOUNT = 500_000; // $5,000, integer cents
const TYPE = "UPC";
const VALUE = "012345678905";
const PAIR = { primaryCodeType: TYPE, primaryCodeValue: VALUE };

const VERIFIED: RegistryPingVerdict = {
  verified: true,
  registryRef: "REG-PARITY-1",
  crossLinks: [{ linkedCodeType: "EAN", linkedCodeValue: "012345678905" }],
  detail: "parity stub verdict",
};

function verifiedRegistry(): RegistryPingClient {
  return {
    pingIdentity: async () => VERIFIED,
  };
}

/** The lifecycle's observable outcome — parity-comparable (ids stripped). */
interface HoldLifecycleProjection {
  /** The escrow row of record after the lock. */
  escrow: {
    kind: string;
    status: string;
    amount_cents: number;
    currency: string;
    line_item_id: string;
    payee_id: string;
  };
  /** The replayed lock's refusal. */
  postReplay: { status: number; code: string };
  /** The verified release's fresh holding credit. */
  released: {
    kind: string;
    status: string;
    amount_cents: number;
    line_item_id: string;
    payee_id: string;
  };
  /** The hold row after the release. */
  holdStatusAfterRelease: string;
  /** The replayed release's refusal (evidence present — the CAS 409s). */
  releaseReplay: { status: number; code: string };
  /** The direct CAS settle on the already-settled row: undefined. */
  casLoser: "undefined" | "won";
  /** Exactly one release journal of record. */
  releaseJournals: number;
}

async function runLifecycle(store: Store): Promise<HoldLifecycleProjection> {
  // 1. The lock.
  const posted = await postIdentifierHoldEscrow(
    store,
    { ...PAIR, amount_cents: AMOUNT, currency: "USD", sourceEventId: EVENT },
    T0,
  );
  if (!posted.ok) throw new Error(`post failed: ${posted.message}`);
  const holdId = posted.value.escrow_credit.id;
  const escrowRow = await store.getLedgerTransaction(holdId);
  if (escrowRow === undefined) throw new Error("escrow row vanished");
  // Snapshot the locked row NOW — the InMemoryStore hands out live
  // references, so a post-release read would observe the release.
  const escrow = {
    kind: escrowRow.kind,
    status: escrowRow.status,
    amount_cents: escrowRow.amount_cents,
    currency: escrowRow.currency,
    line_item_id: escrowRow.line_item_id,
    payee_id: escrowRow.payee_id,
  };

  // 2. The per-source replay guard.
  const replay = await postIdentifierHoldEscrow(
    store,
    { ...PAIR, amount_cents: AMOUNT, currency: "USD", sourceEventId: EVENT },
    T0,
  );
  const postReplay = {
    status: replay.ok ? 0 : replay.status,
    code: replay.ok ? "" : replay.code,
  };

  // 3. The registry ping verifies; the evidence records (the
  // backend-independent seam); the hold does not move.
  const evidence = new InMemoryCrossLinkEvidenceStore();
  const pinged = await pingRegistryToVerifyHeldIdentifier(
    store,
    verifiedRegistry(),
    evidence,
    { ...PAIR, hold_ledger_id: holdId },
    T0,
  );
  if (!pinged.ok) throw new Error(`ping failed: ${pinged.message}`);
  expect(pinged.value.evidence).toHaveLength(1);

  // 4. The verified release — the CAS winner — re-parks the amount as a
  // fresh unclaimed_holding credit.
  const released = await releaseIdentifierHoldEscrow(
    store,
    evidence,
    { hold_ledger_id: holdId, ...PAIR },
    T0,
  );
  if (!released.ok) throw new Error(`release failed: ${released.message}`);
  const holdRowAfter = await store.getLedgerTransaction(holdId);
  if (holdRowAfter === undefined) throw new Error("hold row vanished");

  // 5. The replayed release — the CAS loser (evidence present, row gone).
  const releaseReplay = await releaseIdentifierHoldEscrow(
    store,
    evidence,
    { hold_ledger_id: holdId, ...PAIR },
    T0,
  );

  // 6. The direct CAS settle on the already-settled row — undefined.
  const casLoser = await store.settleIdentifierHoldEscrow(
    holdId,
    T0.toISOString(),
  );

  // 7. Exactly one release journal of record.
  const releaseJournals = (
    await store.listGlJournalsByRef("ledger_transaction", holdId)
  ).filter((j) => j.kind === "unclaimed_identifier_hold_release").length;

  return {
    escrow,
    postReplay,
    released: {
      kind: released.value.released_credit.kind,
      status: released.value.released_credit.status,
      amount_cents: released.value.released_credit.amount_cents,
      line_item_id: released.value.released_credit.line_item_id,
      payee_id: released.value.released_credit.payee_id,
    },
    holdStatusAfterRelease: holdRowAfter.status,
    releaseReplay: {
      status: releaseReplay.ok ? 0 : releaseReplay.status,
      code: releaseReplay.ok ? "" : releaseReplay.code,
    },
    casLoser: casLoser === undefined ? "undefined" : "won",
    releaseJournals,
  };
}

// ---------------------------------------------------------------------------
// The identical lifecycle on every backend.
// ---------------------------------------------------------------------------

describe.each(BACKENDS)("$name — identifier hold lifecycle parity", ({ make }) => {
  it("posts, replays, verifies, releases, and refuses replays identically", async () => {
    const store = make();
    const result = await runLifecycle(store);

    // The lock: the sentinel payee keyed by the scope pair, the
    // quarantined event as the line item, integer cents — identical
    // everywhere.
    expect(result.escrow).toEqual({
      kind: "unclaimed_identifier_hold",
      status: "unclaimed_identifier_hold",
      amount_cents: AMOUNT,
      currency: "USD",
      line_item_id: EVENT,
      payee_id: identifierHoldEscrowPayeeId(
        identifierHoldEscrowScopeKey(TYPE, VALUE),
      ),
    });

    // The replay guard: the same 409 refusal everywhere.
    expect(result.postReplay).toEqual({
      status: 409,
      code: "identifier_hold_already_posted",
    });

    // The verified release: the fresh unclaimed_holding credit carrying
    // the ORIGINAL event id — the normal matching path takes it from
    // there — identical everywhere.
    expect(result.released).toEqual({
      kind: "unclaimed_holding",
      status: "unclaimed_holding",
      amount_cents: AMOUNT,
      line_item_id: EVENT,
      payee_id: "unclaimed",
    });
    expect(result.holdStatusAfterRelease).toBe("settled");

    // The CAS: the loser (replay or concurrent caller) is refused the
    // same way everywhere.
    expect(result.releaseReplay).toEqual({
      status: 409,
      code: "identifier_hold_already_released",
    });
    expect(result.casLoser).toBe("undefined");

    // Exactly one release journal of record.
    expect(result.releaseJournals).toBe(1);
  });
});

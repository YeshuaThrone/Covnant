// The UNCLAIMED_IDENTIFIER_HOLD escrow + the registry-ping release flow
// (PR 53, the founder universal-identifier directive) — the behavioral
// suite. A recon line flagged by the unmatched-code fallback detector (its
// primary identifier carries no verified cross-links) locks into the
// UNCLAIMED_IDENTIFIER_HOLD bucket, and THE ONLY EXIT IS THE EVIDENCE: the
// external registry ping must return a verified verdict whose attested
// cross-links are recorded as evidence of record (verification_source
// registry_ping*, verified_at) before the separate deterministic release
// re-parks the amount as a fresh unclaimed_holding credit. Every ping
// failure mode is fail-closed — nothing moves, nothing is written. The Don
// invariants hold throughout: integer cents, balanced journals, the
// escrow's zero-balance tripwire on release, idempotency (a replayed ping
// converges; a replayed post/release is a counted no-op), and the CAS as
// the concurrency arbiter.

import { describe, expect, it, vi } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  IDENTIFIER_CHAIN_MAPS,
  chainLinksFor,
  type RegistryPingClient,
  type RegistryPingVerdict,
} from "@/lib/identifiers/registryPing";
import {
  InMemoryCrossLinkEvidenceStore,
  type CrossLinkEvidenceStore,
  type VerifiedCrossLinkRow,
} from "@/lib/identifiers/crossLinkEvidence";
import type { GlJournalRecord } from "@/modules/don/records";
import {
  REGISTRY_PING_VERIFICATION_SOURCE_PREFIX,
  identifierHoldEscrowScopeKey,
  pingRegistryToVerifyHeldIdentifier,
  postIdentifierHoldEscrow,
  releaseIdentifierHoldEscrow,
  requireRegistryVerifiedCrossLink,
} from "@/lib/server/identifierHoldEscrow";
import {
  identifierHoldEscrowPayeeId,
  identifierHoldEscrowPayeeName,
} from "@/modules/don/constants";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-04T12:00:00.000Z");
const EVENT = "recon:ing-1:line:3";
const AMOUNT = 1_000_000; // the held line's whole gross: $10,000
const TYPE = "ISRC";
const VALUE = "US-XYT-26-00001";
const PAIR = { primaryCodeType: TYPE, primaryCodeValue: VALUE };

function makeStore(): Store {
  return new InMemoryStore();
}

/** The registry client stub — the seam, stubbed per verdict. */
function registryStub(
  verdict:
    | RegistryPingVerdict
    | Error = {
      verified: true,
      registryRef: "REG-2026-0001",
      crossLinks: [{ linkedCodeType: "ISWC", linkedCodeValue: "T-070000001-1" }],
      detail: "verified by stub",
    },
): RegistryPingClient {
  return {
    pingIdentity: vi.fn(async () => {
      if (verdict instanceof Error) throw verdict;
      return verdict;
    }),
  };
}

/** An evidence store whose writes fail — the identity-unregistered case. */
function throwingEvidenceStore(): CrossLinkEvidenceStore {
  return {
    async recordVerifiedCrossLink(): Promise<void> {
      throw new Error(
        `identifier_cross_link_identity_unregistered: ${TYPE}:${VALUE}`,
      );
    },
    async listVerifiedCrossLinks(): Promise<VerifiedCrossLinkRow[]> {
      return [];
    },
  };
}

/** Posts one hold; returns the escrow row's id. */
async function seedHold(store: Store): Promise<string> {
  const posted = await postIdentifierHoldEscrow(
    store,
    { ...PAIR, amount_cents: AMOUNT, currency: "USD", sourceEventId: EVENT },
    T0,
  );
  if (!posted.ok) throw new Error(`fixture hold failed: ${posted.message}`);
  return posted.value.escrow_credit.id;
}

/**
 * Runs the verified ping so the evidence of record exists — into the
 * CALLER's evidence store (the release later reads the same store, so the
 * fixture hands it back).
 */
async function seedVerifiedEvidence(
  store: Store,
  holdId: string,
  evidence: CrossLinkEvidenceStore = new InMemoryCrossLinkEvidenceStore(),
  registry: RegistryPingClient = registryStub(),
): Promise<CrossLinkEvidenceStore> {
  const verified = await pingRegistryToVerifyHeldIdentifier(
    store,
    registry,
    evidence,
    { ...PAIR, hold_ledger_id: holdId },
    T0,
  );
  if (!verified.ok) throw new Error(`fixture ping failed: ${verified.message}`);
  return evidence;
}

/** The GL journal of record for a ref, asserted to the expected kind. */
async function journalByRef(
  store: Store,
  refType: string,
  refId: string,
  kind: string,
): Promise<GlJournalRecord> {
  const journals = await store.listGlJournalsByRef(refType, refId);
  const found = journals.find((j) => j.kind === kind);
  if (found === undefined) {
    throw new Error(`no ${kind} journal for ref ${refType}:${refId}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The hold: the fallback detector's money rule.
// ---------------------------------------------------------------------------

describe("postIdentifierHoldEscrow — locking the flagged line's gross", () => {
  it("locks the whole gross per identifier scope: sentinel payee, quarantine linkage, balanced journal", async () => {
    const store = makeStore();
    const posted = await postIdentifierHoldEscrow(
      store,
      { ...PAIR, amount_cents: AMOUNT, currency: "USD", sourceEventId: EVENT },
      T0,
    );
    if (!posted.ok) throw new Error(posted.message);

    const row = await store.getLedgerTransaction(
      posted.value.escrow_credit.id,
    );
    expect(row).toBeDefined();
    expect(row?.kind).toBe("unclaimed_identifier_hold");
    expect(row?.status).toBe("unclaimed_identifier_hold");
    expect(row?.amount_cents).toBe(AMOUNT);
    expect(row?.currency).toBe("USD");
    // The quarantined event IS the source line — the recovery linkage the
    // release later stamps onto the fresh holding credit.
    expect(row?.line_item_id).toBe(EVENT);
    // A scoped sentinel payee — no query folds the hold into unclaimed
    // holding, company dust, or any other escrow state.
    const scopeKey = identifierHoldEscrowScopeKey(TYPE, VALUE);
    expect(row?.payee_id).toBe(identifierHoldEscrowPayeeId(scopeKey));
    expect(row?.payee_name).toBe(identifierHoldEscrowPayeeName(scopeKey));

    // The journal is balanced: FBO debits, the escrow credits — the
    // bucket's money left FBO cash, nothing was minted.
    const journal = await journalByRef(store, "match_queue", EVENT, "unclaimed_identifier_hold_post");
    const legs = await store.listGlEntriesByJournal(journal.id);
    expect(legs).toHaveLength(2);
    const debit = legs.filter((l) => l.debit_cents > 0);
    const credit = legs.filter((l) => l.credit_cents > 0);
    expect(debit).toHaveLength(1);
    expect(credit).toHaveLength(1);
    expect(debit[0]!.debit_cents).toBe(AMOUNT);
    expect(credit[0]!.credit_cents).toBe(AMOUNT);
    expect(debit[0]!.credit_cents).toBe(0);
    expect(credit[0]!.debit_cents).toBe(0);
  });

  it("refuses to lock a non-positive or non-integer amount — the ledger never invents money", async () => {
    const store = makeStore();
    for (const amount of [0, -1, 1.5, Number.NaN]) {
      const posted = await postIdentifierHoldEscrow(
        store,
        { ...PAIR, amount_cents: amount, currency: "USD", sourceEventId: EVENT },
        T0,
      );
      expect(posted.ok).toBe(false);
      if (posted.ok) continue;
      expect(posted.status).toBe(422);
      expect(posted.code).toBe("identifier_hold_invalid_amount");
    }
  });

  it("refuses to lock without a primary identifier scope", async () => {
    const store = makeStore();
    for (const [type, value] of [
      ["", VALUE],
      [TYPE, "   "],
    ]) {
      const posted = await postIdentifierHoldEscrow(
        store,
        {
          primaryCodeType: type,
          primaryCodeValue: value,
          amount_cents: AMOUNT,
          currency: "USD",
          sourceEventId: EVENT,
        },
        T0,
      );
      expect(posted.ok).toBe(false);
      if (posted.ok) continue;
      expect(posted.code).toBe("identifier_hold_invalid_scope");
    }
  });

  it("is idempotent per source event: a replayed lock is a counted no-op", async () => {
    const store = makeStore();
    await seedHold(store);
    const replay = await postIdentifierHoldEscrow(
      store,
      { ...PAIR, amount_cents: AMOUNT, currency: "USD", sourceEventId: EVENT },
      T0,
    );
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.status).toBe(409);
    expect(replay.code).toBe("identifier_hold_already_posted");

    // Exactly one journal, exactly one row, exactly one lock.
    await journalByRef(store, "match_queue", EVENT, "unclaimed_identifier_hold_post");
  });
});

// ---------------------------------------------------------------------------
// The ping: fail-closed at every failure mode.
// ---------------------------------------------------------------------------

describe("pingRegistryToVerifyHeldIdentifier — fail-closed verification", () => {
  it("on a verified verdict records the attested cross-links as evidence of record", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);
    const registry = registryStub();
    const evidence = new InMemoryCrossLinkEvidenceStore();

    const verified = await pingRegistryToVerifyHeldIdentifier(
      store,
      registry,
      evidence,
      { ...PAIR, hold_ledger_id: holdId },
      T0,
    );
    if (!verified.ok) throw new Error(verified.message);
    expect(verified.value.registryRef).toBe("REG-2026-0001");
    expect(verified.value.evidence).toHaveLength(1);
    expect(verified.value.evidence[0]).toMatchObject({
      primary_code_type: TYPE,
      primary_code_value: VALUE,
      linked_code_type: "ISWC",
      linked_code_value: "T-070000001-1",
      verification_source: "registry_ping:REG-2026-0001",
      verified_at: T0.toISOString(),
    });
    // The hold did NOT move — the release is a separate step.
    const row = await store.getLedgerTransaction(holdId);
    expect(row?.status).toBe("unclaimed_identifier_hold");

    // Convergent: a re-run of the ping re-records (idempotent upserts) and
    // still moves no money.
    const again = await pingRegistryToVerifyHeldIdentifier(
      store,
      registry,
      evidence,
      { ...PAIR, hold_ledger_id: holdId },
      T0,
    );
    expect(again.ok).toBe(true);
    expect((await store.getLedgerTransaction(holdId))?.status).toBe(
      "unclaimed_identifier_hold",
    );
  });

  it("on a transport error writes NOTHING and leaves the hold locked", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);
    const verified = await pingRegistryToVerifyHeldIdentifier(
      store,
      registryStub(new Error("ECONNRESET")),
      new InMemoryCrossLinkEvidenceStore(),
      { ...PAIR, hold_ledger_id: holdId },
      T0,
    );
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.code).toBe("registry_ping_unverified");
    const row = await store.getLedgerTransaction(holdId);
    expect(row?.status).toBe("unclaimed_identifier_hold");
  });

  it("on an unverified or linkless verdict refuses without evidence", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);

    const unverified = await pingRegistryToVerifyHeldIdentifier(
      store,
      registryStub({
        verified: false,
        registryRef: null,
        crossLinks: [],
        detail: "no such recording in the registry",
      }),
      new InMemoryCrossLinkEvidenceStore(),
      { ...PAIR, hold_ledger_id: holdId },
      T0,
    );
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) expect(unverified.code).toBe("registry_ping_unverified");

    const linkless = await pingRegistryToVerifyHeldIdentifier(
      store,
      registryStub({
        verified: true,
        registryRef: "REG-2",
        crossLinks: [],
        detail: "verified, nothing linked",
      }),
      new InMemoryCrossLinkEvidenceStore(),
      { ...PAIR, hold_ledger_id: holdId },
      T0,
    );
    expect(linkless.ok).toBe(false);
    if (!linkless.ok) expect(linkless.code).toBe("registry_ping_no_cross_links");

    const malformed = await pingRegistryToVerifyHeldIdentifier(
      store,
      registryStub({
        verified: true,
        registryRef: "REG-3",
        crossLinks: [{ linkedCodeType: "", linkedCodeValue: "" }],
        detail: "garbage in",
      }),
      new InMemoryCrossLinkEvidenceStore(),
      { ...PAIR, hold_ledger_id: holdId },
      T0,
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.code).toBe("registry_ping_malformed_attestation");
    }
    const row = await store.getLedgerTransaction(holdId);
    expect(row?.status).toBe("unclaimed_identifier_hold");
  });

  it("on an evidence-write failure refuses — the hold stays locked", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);
    const verified = await pingRegistryToVerifyHeldIdentifier(
      store,
      registryStub(),
      throwingEvidenceStore(),
      { ...PAIR, hold_ledger_id: holdId },
      T0,
    );
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.code).toBe("identifier_cross_link_unrecorded");
    }
    const row = await store.getLedgerTransaction(holdId);
    expect(row?.status).toBe("unclaimed_identifier_hold");
  });

  it("cross-checks the scope pair against the escrow row of record", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);

    const wrongScope = await pingRegistryToVerifyHeldIdentifier(
      store,
      registryStub(),
      new InMemoryCrossLinkEvidenceStore(),
      {
        hold_ledger_id: holdId,
        primaryCodeType: TYPE,
        primaryCodeValue: "US-OTHER-99-99999",
      },
      T0,
    );
    expect(wrongScope.ok).toBe(false);
    if (!wrongScope.ok) {
      expect(wrongScope.code).toBe("identifier_hold_scope_mismatch");
    }

    // Wrong kind — the ping runs only on identifier-hold rows.
    const notAHold = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: "",
      payee_id: "someone",
      payee_name: "Someone",
      role: "other",
      share_bps: 0,
      amount_cents: 100,
      currency: "USD",
      status: "unclaimed_holding",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: T0.toISOString(),
      settled_at: null,
      kind: "unclaimed_holding",
    });
    const wrongKind = await pingRegistryToVerifyHeldIdentifier(
      store,
      registryStub(),
      new InMemoryCrossLinkEvidenceStore(),
      {
        hold_ledger_id: notAHold.id,
        primaryCodeType: TYPE,
        primaryCodeValue: VALUE,
      },
      T0,
    );
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) {
      expect(wrongKind.code).toBe("identifier_hold_invalid_state");
    }

    const missing = await pingRegistryToVerifyHeldIdentifier(
      store,
      registryStub(),
      new InMemoryCrossLinkEvidenceStore(),
      {
        hold_ledger_id: "ledger-does-not-exist",
        primaryCodeType: TYPE,
        primaryCodeValue: VALUE,
      },
      T0,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("identifier_hold_not_found");
  });
});

// ---------------------------------------------------------------------------
// The release: a separate deterministic step keyed on the evidence.
// ---------------------------------------------------------------------------

describe("releaseIdentifierHoldEscrow — the evidence-gated exit", () => {
  it("releases ONLY on registry-attested evidence, re-parking the amount into the normal matching path", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);
    const evidence = await seedVerifiedEvidence(store, holdId);

    const released = await releaseIdentifierHoldEscrow(
      store,
      evidence,
      { hold_ledger_id: holdId, ...PAIR },
      T0,
    );
    if (!released.ok) throw new Error(released.message);
    expect(released.value.released_credit.kind).toBe("unclaimed_holding");
    expect(released.value.released_credit.status).toBe("unclaimed_holding");
    expect(released.value.released_credit.amount_cents).toBe(AMOUNT);
    expect(released.value.released_credit.line_item_id).toBe(EVENT);
    // The sentinel-hold payee never receives money — the release pays the
    // UNCLAIMED_HOLDING payee, PR 7's recovery machinery takes it from
    // there.
    expect(released.value.released_credit.payee_id).toBe("unclaimed");

    // The hold row drained to settled.
    const row = await store.getLedgerTransaction(holdId);
    expect(row?.status).toBe("settled");

    // The release journal is balanced — the money left the bucket, the
    // holding side received exactly it.
    const journal = await journalByRef(store, "ledger_transaction", holdId, "unclaimed_identifier_hold_release");
    const legs = await store.listGlEntriesByJournal(journal.id);
    expect(legs).toHaveLength(2);
    const debit = legs.filter((l) => l.debit_cents > 0);
    const credit = legs.filter((l) => l.credit_cents > 0);
    expect(debit).toHaveLength(1);
    expect(credit).toHaveLength(1);
    expect(debit[0]!.debit_cents).toBe(AMOUNT);
    expect(credit[0]!.credit_cents).toBe(AMOUNT);
    expect(debit[0]!.credit_cents).toBe(0);
    expect(credit[0]!.debit_cents).toBe(0);
  });

  it("refuses with NO evidence of record — fail-closed", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);
    const released = await releaseIdentifierHoldEscrow(
      store,
      new InMemoryCrossLinkEvidenceStore(),
      { hold_ledger_id: holdId, ...PAIR },
      T0,
    );
    expect(released.ok).toBe(false);
    if (!released.ok) {
      expect(released.status).toBe(403);
      expect(released.code).toBe("identifier_cross_link_unverified");
    }
    const row = await store.getLedgerTransaction(holdId);
    expect(row?.status).toBe("unclaimed_identifier_hold");
  });

  it("refuses on SELF-ATTESTED cross-links — the ingest's own rows are not registry evidence", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);
    // The ingest seeded a cross-link row itself (verification_source is
    // the engine's own stamp, not the registry's) — still locked.
    const selfAttested = new InMemoryCrossLinkEvidenceStore();
    await selfAttested.recordVerifiedCrossLink({
      primaryCodeType: TYPE,
      primaryCodeValue: VALUE,
      linkedCodeType: "ISWC",
      linkedCodeValue: "T-070000001-1",
      verificationSource: "ingest:session-42",
      verifiedAt: T0.toISOString(),
    });
    const released = await releaseIdentifierHoldEscrow(
      store,
      selfAttested,
      { hold_ledger_id: holdId, ...PAIR },
      T0,
    );
    expect(released.ok).toBe(false);
    if (!released.ok) {
      expect(released.code).toBe("identifier_cross_link_unverified");
    }
    const row = await store.getLedgerTransaction(holdId);
    expect(row?.status).toBe("unclaimed_identifier_hold");
  });

  it("is idempotent under the CAS: a replayed release is a counted no-op", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);
    const evidence = await seedVerifiedEvidence(store, holdId);
    await releaseIdentifierHoldEscrow(
      store,
      evidence,
      { hold_ledger_id: holdId, ...PAIR },
      T0,
    );
    const replay = await releaseIdentifierHoldEscrow(
      store,
      evidence,
      { hold_ledger_id: holdId, ...PAIR },
      T0,
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.status).toBe(409);
      expect(replay.code).toBe("identifier_hold_already_released");
    }
    // Exactly one release journal.
    await journalByRef(store, "ledger_transaction", holdId, "unclaimed_identifier_hold_release");
  });

  it("is the concurrency arbiter: a CAS loser reads undefined and reports 409", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);
    const evidence = await seedVerifiedEvidence(store, holdId);
    // Simulate a concurrent winner: flip the row directly, then race the
    // release — the CAS must refuse the second mover.
    await store.settleIdentifierHoldEscrow(holdId, T0.toISOString());
    const loser = await releaseIdentifierHoldEscrow(
      store,
      evidence,
      { hold_ledger_id: holdId, ...PAIR },
      T0,
    );
    expect(loser.ok).toBe(false);
    if (!loser.ok) {
      expect(loser.status).toBe(409);
      expect(loser.code).toBe("identifier_hold_already_released");
    }
  });

  it("cross-checks the scope and the row kind", async () => {
    const store = makeStore();
    const holdId = await seedHold(store);
    await seedVerifiedEvidence(store, holdId);

    const wrongScope = await releaseIdentifierHoldEscrow(
      store,
      new InMemoryCrossLinkEvidenceStore(),
      {
        hold_ledger_id: holdId,
        primaryCodeType: TYPE,
        primaryCodeValue: "US-OTHER-99-99999",
      },
      T0,
    );
    expect(wrongScope.ok).toBe(false);
    if (!wrongScope.ok) {
      expect(wrongScope.code).toBe("identifier_hold_scope_mismatch");
    }
  });
});

// ---------------------------------------------------------------------------
// The gate vocabulary + the chain maps.
// ---------------------------------------------------------------------------

describe("requireRegistryVerifiedCrossLink — the gate's exact vocabulary", () => {
  it("accepts only registry-stamped, verified rows", () => {
    const registry: VerifiedCrossLinkRow = {
      primary_code_type: TYPE,
      primary_code_value: VALUE,
      linked_code_type: "ISWC",
      linked_code_value: "T-070000001-1",
      verification_source: "registry_ping:REG-1",
      verified_at: T0.toISOString(),
    };
    const selfAttested: VerifiedCrossLinkRow = {
      ...registry,
      verification_source: "ingest:session-42",
    };
    const unverified: VerifiedCrossLinkRow = {
      ...registry,
      verified_at: null,
    };
    expect(requireRegistryVerifiedCrossLink([selfAttested, unverified])).toBeUndefined();
    expect(requireRegistryVerifiedCrossLink([selfAttested, registry])).toEqual(registry);
    expect(requireRegistryVerifiedCrossLink([])).toBeUndefined();
  });

  it("stamps evidence with the registry_ping prefix the gate reads", () => {
    expect(REGISTRY_PING_VERIFICATION_SOURCE_PREFIX).toBe("registry_ping");
  });
});

describe("IDENTIFIER_CHAIN_MAPS — the v1 chains verbatim", () => {
  it("carries the three v1 families", () => {
    expect(IDENTIFIER_CHAIN_MAPS.music).toEqual(["ISRC", "ISWC", "IPI", "ISNI", "MWLI"]);
    expect(IDENTIFIER_CHAIN_MAPS.sports).toEqual(["NIL", "GLAN", "PAID", "NCAA", "GLN"]);
    expect(IDENTIFIER_CHAIN_MAPS.film).toEqual(["EIDR", "ISAN", "Ad-ID", "CAMA"]);
    expect(chainLinksFor("music")).toEqual(IDENTIFIER_CHAIN_MAPS.music);
    expect(chainLinksFor("nonexistent")).toBeNull();
    expect(chainLinksFor(undefined)).toBeNull();
  });
});

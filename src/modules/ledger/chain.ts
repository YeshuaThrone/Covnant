// GL hash chain — Cursor's Batch 2 ledger/chain.ts.
//
// The chain is only as strong as the previous hash inside the hashed payload:
// each journal's entry_hash is sha256 over its documented payload with the
// previous journal's entry_hash (or the genesis sentinel for sequence 1)
// mixed in. The foundation keeps sequence / prev_hash / entry_hash on the
// journal row, so the chain links journal to journal.

import { createHash } from "node:crypto";
import type { GlLegInput } from "./journal";
import type { GlEntryRecord, GlJournalRecord } from "@/modules/don/records";
import { GL_GENESIS_HASH } from "@/modules/don/constants";

// Everything that participates in the hash — the journal's financial content
// plus its position in the chain.
export type GlChainInput = {
  kind: string;
  ref_type: string;
  ref_id: string;
  legs: GlLegInput[];
  created_at: string;
};

// Documented hash payload (locked by test): legs normalized to their stored
// triple, then created_at, sequence, and prev_hash INSIDE the payload.
// JSON key order is fixed by construction, so equal content hashes equal.
export function hashJournal(
  journal: GlChainInput,
  sequence: number,
  prevHash: string,
): string {
  const payload = JSON.stringify({
    kind: journal.kind,
    ref_type: journal.ref_type,
    ref_id: journal.ref_id,
    legs: journal.legs.map((leg) => ({
      account: leg.account,
      debit_cents: leg.debit_cents,
      credit_cents: leg.credit_cents,
    })),
    created_at: journal.created_at,
    sequence,
    prev_hash: prevHash,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// Entry-level hash over the foundation's GlEntryRecord (the transcription's
// entry rows carried entry_type/ref_type/ref_id/work_id — the merged record
// pins identity to id/journal_id). Position fields stay INSIDE the payload so
// entries hash-chain exactly like journals.
export function hashEntry(
  entry: GlEntryRecord,
  sequence: number,
  prevHash: string,
): string {
  const payload = JSON.stringify({
    id: entry.id,
    journal_id: entry.journal_id,
    account: entry.account,
    debit_cents: entry.debit_cents,
    credit_cents: entry.credit_cents,
    created_at: entry.created_at,
    sequence,
    prev_hash: prevHash,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// --- Chain verification (Cursor's Batch 2 drop, landed with the Covenant
// API integration for the MCP ledger_log / ledger_audit tools). Adapted to
// the canonical hash: the drop's verifyHashChain hashed a single-payload
// object; this body recomputes through this module's hashJournal(journal,
// sequence, prevHash) so verification matches exactly what postJournal
// posted. Journals arrive sequence-ASC (Store ordering contract).

export type ChainVerification = {
  valid: boolean;
  journal_count: number;
  genesis: string;
  broken_at: number | null;
};

export function verifyHashChain(
  journals: ReadonlyArray<GlJournalRecord>,
  legsByJournal: ReadonlyMap<string, GlLegInput[]>,
): ChainVerification {
  if (journals.length === 0) {
    return {
      valid: true,
      journal_count: 0,
      genesis: GL_GENESIS_HASH,
      broken_at: null,
    };
  }
  let previous = GL_GENESIS_HASH;
  for (const journal of journals) {
    if (journal.entry_hash === "" || journal.state !== "posted") {
      return {
        valid: false,
        journal_count: journals.length,
        genesis: GL_GENESIS_HASH,
        broken_at: journal.sequence,
      };
    }
    if (journal.prev_hash !== previous) {
      return {
        valid: false,
        journal_count: journals.length,
        genesis: GL_GENESIS_HASH,
        broken_at: journal.sequence,
      };
    }
    const expected = hashJournal(
      {
        kind: journal.kind,
        ref_type: journal.ref_type,
        ref_id: journal.ref_id,
        created_at: journal.created_at,
        legs: legsByJournal.get(journal.id) ?? [],
      },
      journal.sequence,
      journal.prev_hash,
    );
    if (expected !== journal.entry_hash) {
      return {
        valid: false,
        journal_count: journals.length,
        genesis: GL_GENESIS_HASH,
        broken_at: journal.sequence,
      };
    }
    previous = journal.entry_hash;
  }
  return {
    valid: true,
    journal_count: journals.length,
    genesis: GL_GENESIS_HASH,
    broken_at: null,
  };
}

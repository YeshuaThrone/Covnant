// GL hash chain — Cursor's Batch 2 ledger/chain.ts.
//
// The chain is only as strong as the previous hash inside the hashed payload:
// each journal's entry_hash is sha256 over its documented payload with the
// previous journal's entry_hash (or the genesis sentinel for sequence 1)
// mixed in. The foundation keeps sequence / prev_hash / entry_hash on the
// journal row, so the chain links journal to journal.

import { createHash } from "node:crypto";
import type { GlLegInput } from "./journal";
import type { GlEntryRecord } from "@/modules/don/records";

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

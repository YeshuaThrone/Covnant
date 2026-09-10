// GL posting engine — Cursor's Batch 2 ledger/engine.ts.
//
// One balanced journal, hash-chained onto the last posted journal. Call shape
// and result envelope follow the TS drops (`postJournal(store, {kind,
// ref_type, ref_id, legs}, now)` → `{ok, journal}` / `{ok: false, code,
// message}` — the Phase 3/4 engines branch on `posted.ok` after awaiting).
// Async adaptation only (Store PR contract): the store reads/writes are
// awaited; validation and hash math are untouched.
// The transcription's journal_id/ts/source/source_ref row shape predates the
// merged GlJournalRecord, which the foundation pins to kind/ref_type/ref_id.

import type {
  GlEntryRecord,
  GlJournalRecord,
} from "@/modules/don/records";
import type { Store } from "@/modules/don/storeStub";
import { GL_GENESIS_HASH, type JournalKind } from "@/modules/don/constants";
import { hashJournal } from "./chain";
import { validateJournal, type GlLegInput } from "./journal";

export type PostJournalInput = {
  kind: JournalKind;
  ref_type: string;
  ref_id: string;
  legs: GlLegInput[];
};

export type PostJournalResult =
  | { ok: true; journal: GlJournalRecord }
  | { ok: false; code: "unbalanced_journal"; message: string };

export async function postJournal(
  store: Store,
  input: PostJournalInput,
  now: Date = new Date(),
): Promise<PostJournalResult> {
  const checked = validateJournal(input.legs);
  if (!checked.ok) {
    return {
      ok: false,
      code: "unbalanced_journal",
      message: `postJournal: unbalanced journal (debits ${checked.debits} != credits ${checked.credits})`,
    };
  }

  const created_at = now.toISOString();
  const last = await store.getLatestGlJournal();
  const sequence = (last?.sequence ?? 0) + 1;
  const prev_hash = last?.entry_hash ?? GL_GENESIS_HASH;
  const entry_hash = hashJournal(
    {
      kind: input.kind,
      ref_type: input.ref_type,
      ref_id: input.ref_id,
      legs: input.legs,
      created_at,
    },
    sequence,
    prev_hash,
  );

  // The store allocates ids; the engine supplies the chain state.
  const journal = await store.insertGlJournal({
    kind: input.kind,
    ref_type: input.ref_type,
    ref_id: input.ref_id,
    created_at,
    sequence,
    prev_hash,
    entry_hash,
    state: "posted",
  });
  for (const leg of input.legs) {
    await store.insertGlEntry({
      journal_id: journal.id,
      account: leg.account,
      debit_cents: leg.debit_cents,
      credit_cents: leg.credit_cents,
      created_at,
    });
  }

  return { ok: true, journal };
}

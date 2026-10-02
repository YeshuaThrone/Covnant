-- =============================================================================
-- 0029 — AI training dispute freeze + payout gate states + dataset
--        deprecations (PR 25)
--
-- The AI compliance engine's facts of record, per the founder AI directive
-- + the tokenization patch:
--
--   ai_training_disputes    <- insertAiTrainingDispute / getAiTrainingDispute
--                              / listAiTrainingDisputes / resolveAiTrainingDispute
--     (one rights holder's IP attribution dispute against one model's
--      training dataset version — UNIQUE (ai_model_id, dataset_version,
--      rights_holder_payee_id): a re-filed claim converges on the
--      dispute of record, never a duplicate. An ACTIVE dispute (status
--      'filed') freezes the model's unclaimed-holding legs into status
--      'unauthorized_training_hold' in ledger_transactions — the money
--      stays on the append-only ledger, visibly, and the release path
--      refuses it. The ONLY exit is the verified resolution path: the
--      store's CAS flips filed → resolved (one winner), then the thaw
--      sweep returns the legs to 'unclaimed_holding'.)
--   ai_payout_gate_states   <- upsertAiPayoutGateState / getAiPayoutGateState
--     (one payee's AI payout-gate states of record — UNIQUE per payee_id,
--      an upsert converges: the newest state governs the next dispatch.
--      The AI vertical's compliance state resolves through exactly this
--      row: the release proceeds only when ai_training_consent_state is
--      'verified' AND synthetic_voice_likeness_state is 'released'. The
--      read is FAIL-CLOSED: an absent row (no record) and an 'unknown'
--      stored state BOTH refuse — 'unknown' is a distinct state, the
--      audit trail's "not yet concluded", never a synonym for unverified.)
--   ai_dataset_deprecations <- insertAiDatasetDeprecation /
--                              getAiDatasetDeprecation /
--                              listAiDatasetDeprecationsByModel
--     (one dataset version's deprecation of record — the rights
--      withdrawal / opt-out / model-deprecation fact. UNIQUE
--      (ai_model_id, dataset_version): a re-deprecation converges. The
--      posting pass reads this registry before distributing a training
--      pool: a deprecated version's allocations halt automatically —
--      the withdrawn rights holder's share (every contributor's share
--      when the deprecation names no payee) sweeps to the visible
--      variance dust, conservation exact, never redistributed.)
--   ai_dataset_allocation_archives <- insertAiDatasetAllocationArchive /
--                                     listAiDatasetAllocationArchives
--     (the archival leg — historical posted allocations retired from
--      active attribution WITHOUT deleting or rewriting the append-only
--      ledger rows. UNIQUE (deprecation_id, ledger_transaction_id): a
--      re-run deprecation converges, never double-archives. The archive
--      is a NEW fact ABOUT a ledger row, never a mutation of it.)
--
-- The money discipline: amount_cents is an integer cent count on the
-- archive rows (the Don ledger's whole-cents contract); the state
-- columns are CHECK-constrained tri-states at rest here and
-- lane-enforced at write.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with a full service-role grant (the 0017–0028
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ai_training_disputes: the dispute of record per (model, dataset version,
-- rights holder). status is the freeze state's engine: 'filed' keeps the
-- model's legs frozen; 'resolved' is the verified resolution's outcome —
-- written ONLY through the store's CAS (the UPDATE's WHERE pins status =
-- 'filed', so the first resolver wins and a concurrent resolution reads
-- the loser's undefined). resolution_notes / resolved_by / resolved_at
-- are the verified resolution's audit trail — null while filed.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_training_disputes (
  id                      uuid primary key default gen_random_uuid(),
  ai_model_id             text not null,
  dataset_version         text not null,
  rights_holder_payee_id  text not null,
  rights_holder_payee_name text not null,
  dispute_basis           text not null,
  status                  text not null default 'filed',
  resolution_notes        text,
  resolved_by             text,
  resolved_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (ai_model_id, dataset_version, rights_holder_payee_id),
  constraint ai_training_disputes_status_check
    check (status in ('filed', 'resolved'))
);

create index if not exists ai_training_disputes_status_idx
  on public.ai_training_disputes (status);
create index if not exists ai_training_disputes_model_idx
  on public.ai_training_disputes (ai_model_id);

comment on table public.ai_training_disputes is
  'One rights holder''s IP attribution dispute against a model''s training dataset version. UNIQUE (ai_model_id, dataset_version, rights_holder_payee_id) — a re-filed claim converges. An active (filed) dispute freezes the model''s unclaimed-holding legs into unauthorized_training_hold; the ONLY thaw is the verified resolution path''s CAS (filed → resolved, one winner), then the thaw sweep.';

-- ---------------------------------------------------------------------------
-- ai_payout_gate_states: one payee's AI payout-gate states of record.
-- ai_model_id scopes the recording when the states were taken against a
-- specific model (null = payee-wide). verified_by is the operator
-- identity that recorded the state (the audit trail's "who decided").
-- ---------------------------------------------------------------------------
create table if not exists public.ai_payout_gate_states (
  id                             uuid primary key default gen_random_uuid(),
  payee_id                       text not null,
  ai_model_id                    text,
  ai_training_consent_state      text not null,
  synthetic_voice_likeness_state text not null,
  verified_by                    text,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  unique (payee_id),
  constraint ai_payout_gate_states_consent_check
    check (ai_training_consent_state in ('verified', 'unverified', 'unknown')),
  constraint ai_payout_gate_states_likeness_check
    check (synthetic_voice_likeness_state in ('released', 'withheld', 'unknown'))
);

comment on table public.ai_payout_gate_states is
  'One payee''s AI payout-gate states of record: the AI training-consent state and the synthetic voice/likeness release state (tri-states — unknown is a distinct stored state, not a synonym for unverified). UNIQUE per payee; an upsert converges. The AI vertical''s payout gate reads these fail-closed: absent or unknown refuses; only verified consent AND a released likeness release.';

-- ---------------------------------------------------------------------------
-- ai_dataset_deprecations: the dataset version's deprecation of record.
-- rights_holder_payee_id nulls to a WHOLE-VERSION deprecation (the
-- posting pass halts every contributor's share into the variance dust);
-- set, it halts exactly that contributor's share. deprecated_at is the
-- withdrawal's timestamp of record.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_dataset_deprecations (
  id                       uuid primary key default gen_random_uuid(),
  ai_model_id              text not null,
  dataset_version          text not null,
  reason                   text not null,
  rights_holder_payee_id   text,
  rights_holder_payee_name text,
  deprecated_at            timestamptz not null default now(),
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (ai_model_id, dataset_version),
  constraint ai_dataset_deprecations_reason_check
    check (reason in ('rights_withdrawal', 'model_deprecation', 'tokenization_opt_out'))
);

create index if not exists ai_dataset_deprecations_model_idx
  on public.ai_dataset_deprecations (ai_model_id);

comment on table public.ai_dataset_deprecations is
  'One dataset version''s deprecation of record: the rights withdrawal, model deprecation, or tokenization opt-out. UNIQUE (ai_model_id, dataset_version) — a re-deprecation converges. The posting pass reads this registry before distributing a training pool: a deprecated version''s allocations halt into the visible variance dust (the named payee''s share, or every contributor''s share when no payee is named), conservation exact.';

-- ---------------------------------------------------------------------------
-- ai_dataset_allocation_archives: the deprecation's archival leg. One row
-- per retired ledger allocation: the ledger row's id, the contributor of
-- record, the amount and currency AT ARCHIVE TIME (the snapshot — the
-- archive never reads back through the ledger, so a later status change
-- on the ledger row cannot corrupt the archive of record). The referenced
-- ledger row is NOT touched — the append-only trail stays intact.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_dataset_allocation_archives (
  id                    uuid primary key default gen_random_uuid(),
  deprecation_id        uuid not null references public.ai_dataset_deprecations (id),
  ledger_transaction_id uuid not null,
  contributor_payee_id  text not null,
  amount_cents          integer not null,
  currency              text not null,
  archived_at           timestamptz not null default now(),
  unique (deprecation_id, ledger_transaction_id),
  constraint ai_dataset_allocation_archives_amount_check
    check (amount_cents >= 0)
);

create index if not exists ai_dataset_allocation_archives_deprecation_idx
  on public.ai_dataset_allocation_archives (deprecation_id);

comment on table public.ai_dataset_allocation_archives is
  'The deprecation''s archival leg: one row per historical posted allocation retired from active attribution, snapshotted at archive time (payee, integer cents, currency). UNIQUE (deprecation_id, ledger_transaction_id) — a re-run deprecation converges, never double-archives. The referenced ledger_transactions rows are never deleted or rewritten: the archive is a new fact ABOUT the append-only trail, not a mutation of it.';

-- ---------------------------------------------------------------------------
-- Row-level security: deny-all with an explicit policy, so the
-- "denied by RLS" audit surface stays; the explicit grant keeps the
-- service-role write path.
-- ---------------------------------------------------------------------------

alter table public.ai_training_disputes enable row level security;
alter table public.ai_payout_gate_states enable row level security;
alter table public.ai_dataset_deprecations enable row level security;
alter table public.ai_dataset_allocation_archives enable row level security;

drop policy if exists ai_training_disputes_service_role_all
  on public.ai_training_disputes;
create policy ai_training_disputes_service_role_all
  on public.ai_training_disputes
  for all
  using (false)
  with check (false);

drop policy if exists ai_payout_gate_states_service_role_all
  on public.ai_payout_gate_states;
create policy ai_payout_gate_states_service_role_all
  on public.ai_payout_gate_states
  for all
  using (false)
  with check (false);

drop policy if exists ai_dataset_deprecations_service_role_all
  on public.ai_dataset_deprecations;
create policy ai_dataset_deprecations_service_role_all
  on public.ai_dataset_deprecations
  for all
  using (false)
  with check (false);

drop policy if exists ai_dataset_allocation_archives_service_role_all
  on public.ai_dataset_allocation_archives;
create policy ai_dataset_allocation_archives_service_role_all
  on public.ai_dataset_allocation_archives
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.ai_training_disputes to service_role;
grant select, insert, update, delete on public.ai_payout_gate_states to service_role;
grant select, insert, update, delete on public.ai_dataset_deprecations to service_role;
grant select, insert, update, delete on public.ai_dataset_allocation_archives to service_role;

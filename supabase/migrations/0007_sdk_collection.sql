-- ============================================================================
-- Covnant — Universal Royalty Collection SDK: collection surfaces (0007)
-- PR 3 of Generation 16 (build spec art_MzwqTXym). Adds the SDK's
-- persistence home: MUL clearances (current state + append-only history),
-- the match queue (quarantine-before-match), statement-ingest provenance,
-- and the creator identifier columns the matcher resolves on (ISNI,
-- IPI/CAE, PRO affiliation).
--
-- Conventions, per migrations 0004–0006:
--  - Text UUIDs supplied by the store seam (id text primary key) and
--    timestamptz walls written as ISO strings by the store.
--  - bigint generated always as identity gives each table a total order
--    the store reads back as insertion_order — the PostgreSQL rowid
--    substitute for stable list tie-breaks.
--  - Money is fixed-point micros held as text — never floats.
--  - Raw statement payloads are preserved verbatim (text): recovery and
--    audits re-read the original bytes, never lossy intermediates.
--  - Every statement is `if not exists` / `if not exists`-equivalent
--    idempotent, so re-running the file is a no-op.
--  - RLS is enabled with no policies (deny-all); only the service role
--    (the Don Engine store) reads and writes these tables.
--  - Do not modify Don Engine math: this file adds surfaces only; split,
--    dust, and 100%-balance rules remain untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- MUL clearances — the CURRENT clearance state, one row per catalog asset
-- (unique asset_cbt_code; the store upserts). History lives in
-- mul_clearance_transitions — this table is the projection of that history.
-- ---------------------------------------------------------------------------
create table if not exists public.mul_clearances (
  asset_cbt_code text primary key,
  state text not null default 'draft',
  licensee text,
  territory text,
  term_start timestamptz,
  term_end timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.mul_clearances is
  'Current MUL (Multi-Use License) clearance state per catalog asset. One row per asset_cbt_code; append-only history in mul_clearance_transitions.';
comment on column public.mul_clearances.state is
  'Clearance lifecycle — values draft, requested, cleared, disputed.';

-- ---------------------------------------------------------------------------
-- MUL clearance transitions — append-only audit of the clearance lifecycle.
-- No updates, no deletes: rows are written once and read oldest-first with
-- insertion-order tie-breaks (created_at ties keep write order).
-- ---------------------------------------------------------------------------
create table if not exists public.mul_clearance_transitions (
  id text primary key,
  asset_cbt_code text not null,
  from_state text,
  to_state text not null,
  note text,
  created_at timestamptz not null default now(),
  insertion_order bigint generated always as identity
);

comment on table public.mul_clearance_transitions is
  'Append-only MUL clearance history. from_state null marks the first transition for an asset.';
create index if not exists mul_clearance_transitions_asset_idx
  on public.mul_clearance_transitions (asset_cbt_code, insertion_order);

-- ---------------------------------------------------------------------------
-- Match queue — royalty events that failed exact match are quarantined
-- here verbatim, then resolved to a catalog asset (matched) or dropped
-- (discarded). event_id is unique: an event is quarantined at most once —
-- replays are rejected at the store.
-- ---------------------------------------------------------------------------
create table if not exists public.match_queue (
  id text primary key,
  event_id text not null unique,
  status text not null default 'open',
  reason text not null,
  rights_pipeline text not null,
  source text not null,
  platform text,
  territory text,
  period text,
  currency text,
  gross_micros text,
  identifiers_json text,
  raw_payload text not null,
  matched_cbt_code text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  insertion_order bigint generated always as identity
);

comment on table public.match_queue is
  'Quarantine for royalty events that failed exact match; resolved to matched (CBT-stamped) or discarded. Raw payloads preserved verbatim.';
comment on column public.match_queue.status is
  'Queue lifecycle — values open, matched, discarded. Quarantine-once: event_id is unique.';
comment on column public.match_queue.rights_pipeline is
  'The canonical rights pipeline — values composition_performance, composition_mechanical, master_digital_performance, master_interactive.';
comment on column public.match_queue.gross_micros is
  'Fixed-point gross in micros as text — never a float.';
create index if not exists match_queue_status_idx
  on public.match_queue (status, insertion_order);

-- ---------------------------------------------------------------------------
-- Statement ingests — provenance for every statement file the SDK ingests:
-- the original bytes (content), the parse outcome, and the event count.
-- ---------------------------------------------------------------------------
create table if not exists public.statement_ingests (
  id text primary key,
  format text not null,
  source text not null,
  file_name text not null,
  content text not null,
  status text not null,
  event_count integer,
  error text,
  created_at timestamptz not null default now(),
  insertion_order bigint generated always as identity
);

comment on table public.statement_ingests is
  'Ingest provenance for statement files (CWR/DDEX/CSV): original bytes preserved verbatim plus the parse outcome.';
comment on column public.statement_ingests.format is
  'Statement format — values cwr, ddex, csv_statement.';

-- ---------------------------------------------------------------------------
-- Creator identifier columns — the matcher resolves on these (ISNI, IPI/CAE
-- number, PRO affiliation). Nullable: identity enrichment is optional and
-- per-profile, like migration 0004's compliance columns.
-- ---------------------------------------------------------------------------
alter table public.creator_profiles
  add column if not exists isni text;

alter table public.creator_profiles
  add column if not exists ipi_cae text;

alter table public.creator_profiles
  add column if not exists pro_affiliation text;

comment on column public.creator_profiles.isni is
  'International Standard Name Identifier (ISNI) — 16 digits, optional.';
comment on column public.creator_profiles.ipi_cae is
  'Interested Party (IPI/CAE) number — optional.';
comment on column public.creator_profiles.pro_affiliation is
  'Performing Rights Organization affiliation (e.g. ASCAP, BMI, SESAC) — optional.';

-- ---------------------------------------------------------------------------
-- Row-level security: enabled, zero policies — deny-all by default. The
-- service role bypasses RLS and is the only writer (the store seam).
-- ---------------------------------------------------------------------------
alter table public.mul_clearances enable row level security;
alter table public.mul_clearance_transitions enable row level security;
alter table public.match_queue enable row level security;
alter table public.statement_ingests enable row level security;

grant usage on schema public to service_role;
grant all on public.mul_clearances to service_role;
grant all on public.mul_clearance_transitions to service_role;
grant all on public.match_queue to service_role;
grant all on public.statement_ingests to service_role;
grant select, update on public.creator_profiles to service_role;

-- ---------------------------------------------------------------------------
-- Migration 0020 — VTuber agency holdback states: tax withholding
-- verification + tech setup amortization (Deep Royalties PR 15,
-- todo_U9muGwaR).
--
-- The three tables the VTuber holdback module owns (the LEDGER state itself
-- — kind and status 'avatar_ip_licensing_holdback' — rides the existing
-- ledger_transactions free-text columns, the PR 7/PR 9/PR 13/PR 14
-- precedent; no migration there):
--
--   vtuber_tax_withholding_verifications — the durable state behind the
--     livestream payout gate's tax_withholding_verified read. One row per
--     (payee_id, tax_year): a re-verification replaces the row. Wired to
--     the withholding machinery of record — a 'verified' state is only
--     writable when the payee's creator tax profile (the fields
--     applyWithholding maintains) shows tin_verified AND w9_on_file. The
--     livestream gate refuses on an absent or not-verified state
--     (fail-closed, always).
--
--   vtuber_tech_setup_amortization_schedules — the agency's advanced 3D
--     model rigging / tech setup cost as an immutable contract row: the
--     total cost and the number of periods the recovery spans.
--
--   vtuber_tech_setup_amortization_lines — the consumed lines, APPEND-ONLY
--     and unique per (schedule_ref, line_index): the PR 12 accumulator's
--     insert-as-lock discipline. The line's integer cents are computed by
--     the pure schedule math (floor(total/periods), the last line absorbing
--     the remainder); a concurrent consume throws on the unique pair, never
--     a lost update.
--
-- ADDITIVE migration at the next-free number (0011-0019 are taken; 0019 is
-- the gaming cashout state, merged to main). Nothing existing is dropped or
-- altered. House pattern (0006/0010/0011/0017/0019): check-constrained
-- vocabulary, RLS deny-all, full service_role grant, insertion_order
-- bigint. This file is idempotent — CI applies it twice; every object uses
-- IF NOT EXISTS.
-- ---------------------------------------------------------------------------

create table if not exists public.vtuber_tax_withholding_verifications (
  id             uuid primary key default gen_random_uuid(),
  -- The payee's sovereign identity — UNIQUE with tax_year: one
  -- verification state per payee per year; a re-verification replaces the
  -- row (the studio-KYC precedent at year scope).
  payee_id       text not null,
  tax_year       integer not null check (tax_year > 0),
  -- 'verified' is the only state the livestream gate accepts; pending and
  -- failed refuse (fail-closed).
  state          text not null
                 check (state in ('pending', 'verified', 'failed')),
  -- The payee's withholding profile of record at verification time — the
  -- fields the withholding engine (applyWithholding) maintains. The
  -- TypeScript writer refuses a 'verified' state without both true; the
  -- columns keep the row auditable without a second hop.
  tin_verified   boolean not null default false,
  w9_on_file     boolean not null default false,
  -- The withholding evidence the verification cites — REQUIRED for a
  -- 'verified' state (the livestream gate's own rule: withholding evidence
  -- is mandatory). Enforced by the TypeScript registration gate.
  evidence_ref   text,
  verified_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (payee_id, tax_year)
);

comment on table public.vtuber_tax_withholding_verifications is
  'VTuber agency holdback states (PR 15): the durable tax-withholding verification behind the livestream payout gate''s tax_withholding_verified read — one row per payee per tax year. A ''verified'' state requires a verified creator tax profile (TIN + W-9 of record) and cited evidence; absent or pending rows refuse the gate.';
comment on column public.vtuber_tax_withholding_verifications.payee_id is
  'The payee''s sovereign identity — UNIQUE with tax_year; a re-verification replaces the row.';
comment on column public.vtuber_tax_withholding_verifications.tax_year is
  'The tax year the verification covers — withholding is annual.';
comment on column public.vtuber_tax_withholding_verifications.state is
  'The verification state — pending | verified | failed. Only ''verified'' passes the livestream gate.';
comment on column public.vtuber_tax_withholding_verifications.evidence_ref is
  'The withholding evidence of record (a ''verified'' state requires it) — the livestream gate''s mandatory-evidence rule.';

create index if not exists idx_vtuber_tax_verifications_payee
  on public.vtuber_tax_withholding_verifications (payee_id, tax_year);

create table if not exists public.vtuber_tech_setup_amortization_schedules (
  id                   uuid primary key default gen_random_uuid(),
  -- The contract's own schedule reference — UNIQUE: one schedule per
  -- contract reference, ever.
  schedule_ref         text not null unique,
  -- The agency payee the recovered deductions route to (the advanced
  -- cost's owner) — the Don store's sovereign identity, not a match_queue
  -- row, so no FK there (the 0017/0019 precedent).
  agency_payee_id      text not null,
  description          text not null,
  -- The advanced cost, whole integer cents — conserved exactly across the
  -- lines the schedule math derives.
  total_cost_cents     bigint not null check (total_cost_cents > 0),
  -- The number of integer-cent line deductions — at least one (a zero-
  -- period schedule amortizes nothing and is not a schedule).
  amortization_periods integer not null check (amortization_periods > 0),
  created_at           timestamptz not null default now()
);

comment on table public.vtuber_tech_setup_amortization_schedules is
  'VTuber agency holdback states (PR 15): one tech setup amortization contract — the agency''s advanced 3D model rigging / tech setup cost, recovered as deterministic integer-cent line deductions across releases. The row is the immutable contract; consumption lives in the append-only lines.';
comment on column public.vtuber_tech_setup_amortization_schedules.schedule_ref is
  'The contract''s own schedule reference — UNIQUE: one schedule per reference, ever; a duplicate insert throws (the replay surface).';
comment on column public.vtuber_tech_setup_amortization_schedules.total_cost_cents is
  'The advanced cost in whole integer cents — floor(total/periods) per line with the last line absorbing the remainder conserves it exactly.';

create table if not exists public.vtuber_tech_setup_amortization_lines (
  id             uuid primary key default gen_random_uuid(),
  -- The schedule the line consumes — vtuber_tech_setup_amortization_
  -- schedules.schedule_ref is TEXT (this migration) — the FK matches the
  -- referenced column's type exactly (the 0011/0017/0019 precedent).
  schedule_ref   text not null,
  -- Zero-based line position — UNIQUE with schedule_ref: the insert-as-lock
  -- consume arbiter (the PR 12 accumulator discipline).
  line_index     integer not null check (line_index >= 0),
  -- The line's integer-cent deduction as applied — the deterministic
  -- schedule math caps at what the release's stack left (the honest
  -- shortfall carry, the PR 14 precedent).
  line_cents     bigint not null check (line_cents >= 0),
  deducted_at    timestamptz not null,
  created_at     timestamptz not null default now(),
  insertion_order bigint generated always as identity,
  unique (schedule_ref, line_index)
);

comment on table public.vtuber_tech_setup_amortization_lines is
  'VTuber agency holdback states (PR 15): one consumed amortization line — append-only, unique per (schedule_ref, line_index). A concurrent consume of the same line throws on the unique pair, never a lost update; sum of lines conserved against the schedule''s total by the pure schedule math.';
comment on column public.vtuber_tech_setup_amortization_lines.line_index is
  'Zero-based line position — UNIQUE with schedule_ref: the insert-as-lock consume arbiter.';
comment on column public.vtuber_tech_setup_amortization_lines.line_cents is
  'The line''s integer-cent deduction as applied — the deterministic line capped at what the release''s stack left (the shortfall is reported in the release plan, never hidden).';

-- ---------------------------------------------------------------------------
-- Foreign keys: the amortization line hangs off its schedule (a consumed
-- line cannot exist without its contract — the per-source guard made
-- structural). schedules.schedule_ref is TEXT not null unique (this
-- migration) — the FK matches the referenced column's type exactly (the
-- 0011/0017/0019 precedent). The verification's payee and the schedule's
-- agency payee are the Don store's sovereign identities — not match_queue
-- rows, so no FK there (the 0017/0019 precedent).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.vtuber_tech_setup_amortization_lines'::regclass
      and conname = 'fk_vtuber_amortization_lines_schedule'
  ) then
    alter table public.vtuber_tech_setup_amortization_lines
      add constraint fk_vtuber_amortization_lines_schedule
      foreign key (schedule_ref)
      references public.vtuber_tech_setup_amortization_schedules (schedule_ref);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Authorization: RLS deny-all (no policies) + full service-role grants, the
-- migrations 0001-0019 convention. The store seam is the only writer; the
-- withholding verification writer and the release path's amortization
-- consume are the only readers.
-- ---------------------------------------------------------------------------

alter table public.vtuber_tax_withholding_verifications enable row level security;
alter table public.vtuber_tech_setup_amortization_schedules enable row level security;
alter table public.vtuber_tech_setup_amortization_lines enable row level security;
grant all on public.vtuber_tax_withholding_verifications to service_role;
grant all on public.vtuber_tech_setup_amortization_schedules to service_role;
grant all on public.vtuber_tech_setup_amortization_lines to service_role;

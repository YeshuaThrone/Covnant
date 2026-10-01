-- ---------------------------------------------------------------------------
-- Migration 0019 — gaming cashout states: DevEx conversion logs + studio KYC
-- (Deep Royalties PR 13, todo_3VXsvB7t).
--
-- The two tables the gaming cashout module owns (the LEDGER state itself —
-- kind and status 'virtual_currency_cashout_pending' — rides the existing
-- ledger_transactions free-text columns, the PR 7/PR 9 precedent; no
-- migration there):
--
--   gaming_devex_conversion_logs — the durable DevEx conversion record (the
--     founder's rate-logging rule, made state). One row per funding line
--     (unique on event_id, the content-derived `gaming:devex:<line event
--     id>`): the virtual-currency denomination, the exact virtual amount,
--     the applied exchange rate, the integer-cent fiat net, and the payout
--     batch the conversion rides. Status holds 'pending_fiat_settlement'
--     until the platform's fiat settlement completes, then flips
--     'fiat_settled' — a batch releases only when its logs EXIST and are
--     ALL settled (completeness). A replayed ingest re-derives the same
--     event_id and the UNIQUE constraint turns the replay into a counted
--     no-op — the PR 12 accumulator's insert-as-lock pattern.
--
--   gaming_studio_kyc_verifications — one studio's KYC verification state:
--     the studio's own KYC status PLUS the named roster (3D artist,
--     developer, sound designer, ...) with each member's identity-check
--     outcome. One row per studio payee (unique): a re-verification
--     replaces the row. The gaming payout gate reads this through the
--     wired vertical-state source and REFUSES on an absent record — no
--     state is never assumed verified (fail-closed).
--
-- ADDITIVE migration at the next-free number (0011-0018 are taken; 0018 is
-- the gaming fee parser, merged to main). Nothing existing is dropped or
-- altered. House pattern (0006/0010/0011/0017): check-constrained
-- vocabulary, RLS deny-all, full service_role grant, insertion_order
-- bigint. This file is idempotent — CI applies it twice; every object uses
-- IF NOT EXISTS.
-- ---------------------------------------------------------------------------

create table if not exists public.gaming_devex_conversion_logs (
  id                   uuid primary key default gen_random_uuid(),
  -- The content-derived `gaming:devex:<line event id>` — one log per
  -- funding line, ever. UNIQUE is the replay arbiter.
  event_id             text not null unique,
  -- match_queue.event_id is TEXT (0007) — the FK must match the referenced
  -- column's type exactly (the 0011/0017 precedent).
  line_event_id        text not null,
  platform             text not null,
  denomination         text not null,
  -- Exact decimal TEXT — never a float (the DevEx converter's canon).
  virtual_amount       text not null,
  exchange_rate        text not null,
  fiat_net_cents       bigint not null check (fiat_net_cents >= 0),
  settlement_batch_ref text not null,
  status               text not null default 'pending_fiat_settlement'
                       check (status in ('pending_fiat_settlement', 'fiat_settled')),
  settled_at           timestamptz,
  created_at           timestamptz not null default now(),
  insertion_order      bigint generated always as identity
);

comment on table public.gaming_devex_conversion_logs is
  'Gaming cashout states (PR 13): the durable DevEx conversion log — one row per funding line, holding until the platform payout batch''s fiat settlement completes. The release path reads a batch''s logs and refuses while any is pending (completeness).';
comment on column public.gaming_devex_conversion_logs.event_id is
  'The content-derived id `gaming:devex:<line event id>` — identity is WHAT converted, never when. UNIQUE: the replay arbiter (a replayed ingest derives the same id and counts as a no-op).';
comment on column public.gaming_devex_conversion_logs.line_event_id is
  'The funding queue event the conversion came from — match_queue.event_id (0007), FK-enforced.';
comment on column public.gaming_devex_conversion_logs.virtual_amount is
  'The exact virtual amount as decimal TEXT — never a float (the DevEx converter''s exact-decimal canon).';
comment on column public.gaming_devex_conversion_logs.exchange_rate is
  'The applied fiat-per-virtual-unit exchange rate as decimal TEXT — the founder rate-logging rule, retained verbatim.';
comment on column public.gaming_devex_conversion_logs.fiat_net_cents is
  'The conversion''s fiat net in whole integer cents — the money that locked into cashout-pending; sub-cent residue never rounds up.';
comment on column public.gaming_devex_conversion_logs.settlement_batch_ref is
  'The platform payout batch the conversion rides — the release path''s cross-reference and fiat-settlement key.';
comment on column public.gaming_devex_conversion_logs.status is
  'Fiat-settlement state — pending_fiat_settlement until the batch''s fiat settlement completes, then fiat_settled. A batch releases only when ALL its logs are fiat_settled.';

create index if not exists idx_gaming_devex_conversion_logs_batch
  on public.gaming_devex_conversion_logs (settlement_batch_ref, created_at);

create table if not exists public.gaming_studio_kyc_verifications (
  id                uuid primary key default gen_random_uuid(),
  -- UNIQUE: one verification state per studio payee — a re-verification
  -- replaces the row (the Don store's sovereign identity is the key).
  studio_payee_id   text not null unique,
  studio_kyc_status text not null
                    check (studio_kyc_status in ('pending', 'verified', 'failed')),
  -- The named roster: member_ref, role, and identity_check_passed per
  -- member. NOT NULL and non-empty — an empty roster is not a verification
  -- ("covers every named team member" with zero named members passes
  -- nothing); the TypeScript module is the registration gate.
  team_members      jsonb not null
                    check (jsonb_typeof(team_members) = 'array'
                           and jsonb_array_length(team_members) > 0),
  contract_ref      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.gaming_studio_kyc_verifications is
  'Gaming cashout states (PR 13): one studio''s KYC verification — the studio''s own status plus every named team member''s identity check (3D artist, developer, sound designer, ...). The gaming payout gate refuses on an absent record: no state is never assumed verified.';
comment on column public.gaming_studio_kyc_verifications.studio_payee_id is
  'The studio''s payee id — the Don store''s sovereign identity. UNIQUE: one row per studio; a re-verification replaces it.';
comment on column public.gaming_studio_kyc_verifications.studio_kyc_status is
  'The studio''s own KYC status — the Don KYC vocabulary (pending | verified | failed). The gate requires ''verified''.';
comment on column public.gaming_studio_kyc_verifications.team_members is
  'The named roster: [{member_ref, role, identity_check_passed}] — every member the studio-level verification covers. The gate requires EVERY member''s identity_check_passed = true; an empty roster is refused at registration and by check constraint.';

-- ---------------------------------------------------------------------------
-- Foreign keys: the conversion log hangs off its funding queue row (a
-- conversion log cannot exist without its funding event — the per-source
-- guard made structural). match_queue.event_id is TEXT not null unique
-- (0007) — the FK matches the referenced column's type exactly (the 0011
-- precedent). The studio KYC verification's payee is the Don store's
-- sovereign identity — not a match_queue row, so no FK there (the 0017
-- bonus-accrual precedent).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.gaming_devex_conversion_logs'::regclass
      and conname = 'fk_gaming_devex_logs_line_event'
  ) then
    alter table public.gaming_devex_conversion_logs
      add constraint fk_gaming_devex_logs_line_event
      foreign key (line_event_id) references public.match_queue (event_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Authorization: RLS deny-all (no policies) + full service-role grants, the
-- migrations 0001-0018 convention. The store seam is the only writer; the
-- cashout release path and the gaming payout gate are the only readers.
-- ---------------------------------------------------------------------------

alter table public.gaming_devex_conversion_logs enable row level security;
alter table public.gaming_studio_kyc_verifications enable row level security;
grant all on public.gaming_devex_conversion_logs to service_role;
grant all on public.gaming_studio_kyc_verifications to service_role;

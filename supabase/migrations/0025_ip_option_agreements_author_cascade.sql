-- =============================================================================
-- 0025 — IP adaptation optioning: the author-first option-fee cascade (PR 21)
--
-- The contract layer the IP option release lane reads:
--
--   ip_option_agreements                  <- getIpOptionAgreement /
--                                            releaseIpOptionFeeFromHolding
--     (the option deal of record per work: the original author — the IP
--      holder and the cascade's residual holder — the agency of record,
--      and the agency's commission in basis points OF THE REMAINDER)
--   ip_option_author_allocations          <- listIpOptionAuthorAllocations /
--                                            buildIpOptionReleasePlan
--     (the ring-fenced author-side IP allocations, basis points OF THE
--      FEE — reserved BEFORE any agency commission exists; the table's
--      insertion_order IS the deterministic author-first reservation
--      order, one row per (work, payee))
--   publishing_ip_rights_verifications    <- verifyPublishingIpRights /
--                                            resolvePublishingIpRightsCleared
--     (the durable ip_rights_cleared state the publishing payout gate
--      reads for option-fee dispatch — the VTuber tax-withholding
--      verification's per-payee pattern, migration 0020, at work scope:
--      one row per (payee, work), upsert on the pair)
--
-- Work identity: optioned works arrive from statement feeds (the recon
-- lane's work id), not the asset registry — work_id is text, matching the
-- queue's recorded value. The one FK is the allocation's guarded reference
-- to its work's agreement of record (text -> text UNIQUE, type-matched):
-- an allocation cannot exist for a work that has no registered option
-- deal, and dropping the agreement cascades nothing — the registry is the
-- contract layer.
--
-- The founder's inverted priority, for the schema reader: the translation
-- cascade (0024) pays the LOCALIZER before the author's net; this lane
-- pays the AUTHOR's IP allocations first and the agency's commission only
-- from the remainder. The ordering is enforced by buildIpOptionReleasePlan
-- (plan-time, fail-closed); the schema carries the terms of record.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with a full service-role grant (the 0017–0024
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ip_option_agreements: the option deal of record per work. One row per
-- work (upsert on work_id — a re-registered agreement replaces the row
-- atomically, the localization-contract precedent). The agency's
-- commission is basis points OF THE REMAINDER (after every author IP
-- allocation is reserved — never of the gross); option_deal_ref is the
-- signed agreement the terms were extracted from.
-- ---------------------------------------------------------------------------
create table if not exists public.ip_option_agreements (
  id                     uuid primary key default gen_random_uuid(),
  work_id                text not null,
  author_payee_id        text not null,
  author_payee_name      text not null,
  agency_payee_id        text not null,
  agency_payee_name      text not null,
  agency_commission_bps  integer not null,
  option_deal_ref        text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (work_id),
  constraint ip_option_agreements_commission_bps_check
    check (agency_commission_bps >= 0 and agency_commission_bps <= 10000)
);

comment on table public.ip_option_agreements is
  'The film/TV/gaming option deal of record per work: the original author (IP holder, residual holder), the agency of record, and the agency''s commission in basis points OF THE REMAINDER — after every author IP allocation is reserved, never of the gross. Upsert on work_id.';

-- ---------------------------------------------------------------------------
-- ip_option_author_allocations: the ring-fenced author-side IP allocations.
-- Basis points OF THE OPTION FEE (1..10000), reserved BEFORE any agency
-- commission exists. insertion_order is the deterministic author-first
-- reservation order; UNIQUE (work_id, payee_id) forbids a duplicate
-- registration (the replay surface — a re-registration is the 23505, never
-- a double reservation). The FK guards the agreement of record: text ->
-- text UNIQUE, type-matched.
-- ---------------------------------------------------------------------------
create table if not exists public.ip_option_author_allocations (
  id              uuid primary key default gen_random_uuid(),
  work_id         text not null,
  payee_id        text not null,
  payee_name      text not null,
  allocation_bps  integer not null,
  created_at      timestamptz not null default now(),
  insertion_order bigint generated always as identity,
  unique (work_id, payee_id),
  constraint ip_option_author_allocations_work_fk
    foreign key (work_id) references public.ip_option_agreements (work_id)
    on delete cascade,
  constraint ip_option_author_allocations_bps_check
    check (allocation_bps > 0 and allocation_bps <= 10000)
);

create index if not exists ip_option_author_allocations_work_order_idx
  on public.ip_option_author_allocations (work_id, insertion_order);

comment on table public.ip_option_author_allocations is
  'One ring-fenced author-side IP allocation per (work, payee): basis points OF THE option fee, reserved before any agency commission exists (the founder author-first ordering). insertion_order is the deterministic reservation order; the cascade pays these first, the agency commission from the remainder, the author of record''s residual last.';

-- ---------------------------------------------------------------------------
-- publishing_ip_rights_verifications: the durable ip_rights_cleared state
-- the publishing payout gate reads for option-fee dispatch (the VTuber
-- tax-withholding verification's per-payee pattern, migration 0020, at
-- work scope). One row per (payee, work); a re-verification replaces the
-- row atomically (upsert on the pair). Only an explicit 'cleared' state
-- passes the gate — absent, pending, and failed all refuse, fail-closed;
-- a 'cleared' state carries mandatory evidence (the clearance's
-- provenance of record).
-- ---------------------------------------------------------------------------
create table if not exists public.publishing_ip_rights_verifications (
  id           uuid primary key default gen_random_uuid(),
  payee_id     text not null,
  work_id      text not null,
  state        text not null,
  evidence_ref text,
  cleared_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (payee_id, work_id),
  constraint publishing_ip_rights_verifications_state_check
    check (state in ('pending', 'cleared', 'failed'))
);

create index if not exists publishing_ip_rights_verifications_work_idx
  on public.publishing_ip_rights_verifications (work_id);

comment on table public.publishing_ip_rights_verifications is
  'The durable IP-rights verification state the publishing payout gate reads for option-fee dispatch: one row per (payee, work), upsert on the pair. Only state ''cleared'' passes the gate — absent, pending, and failed all refuse, fail-closed; ''cleared'' requires evidence_ref (the clearance''s provenance).';

-- ---------------------------------------------------------------------------
-- RLS: deny-all (every policy false). Service role bypasses RLS; the
-- explicit grant keeps the "denied by RLS" audit surface the schema job
-- checks.
-- ---------------------------------------------------------------------------

alter table public.ip_option_agreements enable row level security;
alter table public.ip_option_author_allocations enable row level security;
alter table public.publishing_ip_rights_verifications enable row level security;

drop policy if exists ip_option_agreements_service_role_all
  on public.ip_option_agreements;
create policy ip_option_agreements_service_role_all
  on public.ip_option_agreements
  for all
  using (false)
  with check (false);

drop policy if exists ip_option_author_allocations_service_role_all
  on public.ip_option_author_allocations;
create policy ip_option_author_allocations_service_role_all
  on public.ip_option_author_allocations
  for all
  using (false)
  with check (false);

drop policy if exists publishing_ip_rights_verifications_service_role_all
  on public.publishing_ip_rights_verifications;
create policy publishing_ip_rights_verifications_service_role_all
  on public.publishing_ip_rights_verifications
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.ip_option_agreements to service_role;
grant select, insert, update, delete on public.ip_option_author_allocations to service_role;
grant select, insert, update, delete on public.publishing_ip_rights_verifications to service_role;

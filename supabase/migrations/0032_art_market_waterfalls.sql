-- =============================================================================
-- 0032 — Art-market waterfalls: fabrication recoupment pools, split
-- schedules, and licensing agency policies (PR 28)
--
-- The art-market payout protections' durable facts of record, per the
-- founder directive:
--
--   art_recoupment_pools          <- registerArtRecoupmentPool /
--                                    listArtRecoupmentPools
--     (the fabrication debt of record per (scope_key, pool_class,
--      sequence_no) — the print edition's master-printmaker and
--      lithographer bills and the sculpture's bronze-foundry and
--      3D-printing bills, in the fabrication contract's recoupment order.
--      UNIQUE per (scope_key, pool_class, sequence_no): the sequence is
--      the contract's order of record; one pool per position. debt_cents
--      is the fronted cost; recouped_cents the running recovery — the
--      applications ledger below is the truth, this running counter is
--      the fast read the position locks arbiterate.)
--   art_recoupment_applications   <- insertArtRecoupmentApplication /
--                                    listArtRecoupmentApplications
--     (the append-only recovery ledger, the books reserve-drawdown
--      discipline (0030/0031) at waterfall scope. UNIQUE per (pool_id,
--      source_event_id): a replayed application is the unique violation,
--      never a double recovery. UNIQUE per (pool_id,
--      recouped_before_cents): the POSITION lock — the insert-as-lock
--      arbiter (the PR 12/PR 99/webtoon discipline) — so two concurrent
--      applications of one pool compute the same running position and
--      exactly one wins it; the loser re-derives from the append-only
--      truth. The applied sum IS the pool's recovery — derived, never a
--      second mutable counter.)
--   art_split_schedules           <- registerArtSplitSchedule /
--                                    getArtSplitSchedule
--     (the post-recoupment percentage split of record per scope_key —
--      the founder's example cut (50% artist / 30% gallery / 20% master
--      printmaker) and the sculpture's studio-assistant and co-creator
--      releases. contributors is the jsonb roster of
--      ArtSplitContributorSpec rows (whole basis points of the
--      post-recoupment net; the roster is a schedule artifact, read
--      whole — the 0030 contributors discipline). UNIQUE per scope_key: a
--      re-registration replaces the row atomically and increments
--      version; accrued cuts keep their version's event ids — history,
--      never re-cut.)
--   art_split_accruals            <- insertArtSplitAccrual /
--                                    listArtSplitAccruals
--     (the append-only accrual ledger: allocations is the jsonb array of
--      per-payee designated shares ({ payee_id, payee_name,
--      share_cents }); dust_cents is the visible sub-cent residue of a
--      percentage cut — conservation: allocations + dust = basis, exact,
--      nothing rounds up into a contributor's credit. UNIQUE per
--      (schedule_id, source_event_id): the once-only guard — the unique
--      violation IS the replay signal.)
--   art_licensing_agency_policies <- upsertArtLicensingAgencyPolicy /
--                                    getArtLicensingAgencyPolicy
--     (the copyright agency's collection-fee rate of record per
--      agency_code — ARS and DACS, CONFIGURABLE inside the founder's
--      15–20% band: collection_fee_bps whole basis points in [1500,
--      2000], CHECK-enforced at rest and lane-enforced at write — the
--      0031 book_returns_reserve_policies band discipline. The museum
--      licensing row's applied fee is validated against the same band at
--      parse; the policy is the administration's registered rate.)
--
-- The isolation firewall: pool_class carries its own class vocabulary
-- ('print_edition_fabrication', 'sculpture_fabrication') — a print
-- edition's sales recoup ONLY print-edition pools and a sculpture's
-- sales ONLY sculpture pools; museum licensing money and ARR resales
-- touch neither. scope carries the waterfall's identity
-- ('print_edition', 'sculpture_fabrication') keyed on the edition or
-- sculpture scope_key.
--
-- The money discipline: every *_cents column is an integer cent count
-- (the Don ledger's whole-cents contract). Ledger-child tables carry the
-- 0027 foreign-key discipline (cascade on delete); the policy table is
-- keyed by its natural key (agency_code) with no ledger reference.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with a full service-role grant (the 0017–0031
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- art_recoupment_pools: the fabrication debt of record per (scope_key,
-- pool_class, sequence_no) — the waterfall's debt sequence in the order
-- the fabrication contract names.
-- ---------------------------------------------------------------------------
create table if not exists public.art_recoupment_pools (
  id                  uuid primary key default gen_random_uuid(),
  scope_key           text not null,
  pool_class          text not null,
  sequence_no         integer not null,
  debt_cents          integer not null,
  recouped_cents      integer not null default 0,
  currency            text not null,
  status              text not null default 'active',
  creditor_role       text not null,
  creditor_payee_id   text not null,
  creditor_payee_name text not null,
  agreement_ref       text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (scope_key, pool_class, sequence_no),
  constraint art_recoupment_pools_class_check
    check (pool_class in ('print_edition_fabrication', 'sculpture_fabrication')),
  constraint art_recoupment_pools_creditor_role_check
    check (creditor_role in ('master_printmaker', 'lithographer', 'bronze_foundry', 'three_d_printing')),
  constraint art_recoupment_pools_status_check
    check (status in ('active', 'recouped')),
  constraint art_recoupment_pools_sequence_check
    check (sequence_no >= 1),
  constraint art_recoupment_pools_debt_check
    check (debt_cents > 0),
  constraint art_recoupment_pools_recouped_check
    check (recouped_cents >= 0 and recouped_cents <= debt_cents)
);

create index if not exists art_recoupment_pools_scope_idx
  on public.art_recoupment_pools (scope_key);

comment on table public.art_recoupment_pools is
  'The fabrication debt of record per (scope_key, pool_class, sequence_no): the print edition''s master-printmaker and lithographer bills and the sculpture''s bronze-foundry and 3D-printing bills in the fabrication contract''s recoupment order. UNIQUE (scope_key, pool_class, sequence_no): one pool per position. recouped_cents is the running recovery — the applications ledger is the truth, this counter is the fast read the position locks arbiterate.';

-- ---------------------------------------------------------------------------
-- art_recoupment_applications: the append-only recovery ledger — the
-- books reserve-drawdown discipline (0030/0031) at waterfall scope. Both
-- unique constraints are load-bearing: the first is the replay guard
-- (the same revenue event can never recoup twice); the second the
-- concurrent-writer arbiter (the insert-as-lock position lock per pool).
-- ---------------------------------------------------------------------------
create table if not exists public.art_recoupment_applications (
  id                     uuid primary key default gen_random_uuid(),
  pool_id                uuid not null,
  pool_class             text not null,
  scope_key              text not null,
  source_event_id        text not null,
  recouped_before_cents  integer not null,
  applied_cents          integer not null,
  remaining_cents        integer not null,
  created_at             timestamptz not null default now(),
  unique (pool_id, source_event_id),
  unique (pool_id, recouped_before_cents),
  constraint art_recoupment_applications_pool_fk
    foreign key (pool_id) references public.art_recoupment_pools (id)
    on delete cascade,
  constraint art_recoupment_applications_class_check
    check (pool_class in ('print_edition_fabrication', 'sculpture_fabrication')),
  constraint art_recoupment_applications_before_check
    check (recouped_before_cents >= 0),
  constraint art_recoupment_applications_amount_check
    check (applied_cents > 0),
  constraint art_recoupment_applications_remaining_check
    check (remaining_cents >= 0)
);

create index if not exists art_recoupment_applications_pool_idx
  on public.art_recoupment_applications (pool_id);

comment on table public.art_recoupment_applications is
  'The append-only fabrication-recoupment ledger: one row per (pool, source revenue event). UNIQUE (pool_id, source_event_id) is the replay guard; UNIQUE (pool_id, recouped_before_cents) is the insert-as-lock position arbiter. The applied sum is the pool''s recovery — derived, never a second mutable counter.';

-- ---------------------------------------------------------------------------
-- art_split_schedules: the post-recoupment percentage split of record per
-- scope_key. contributors is the jsonb roster of ArtSplitContributorSpec
-- rows (whole basis points of the post-recoupment net; read whole — the
-- 0030 contributors discipline). UNIQUE (scope_key): a re-registration
-- replaces the row atomically and increments version.
-- ---------------------------------------------------------------------------
create table if not exists public.art_split_schedules (
  id           uuid primary key default gen_random_uuid(),
  scope_key    text not null,
  scope        text not null check (scope in ('print_edition', 'sculpture_fabrication')),
  contributors jsonb not null,
  version      integer not null default 1 check (version >= 1),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (scope_key)
);

comment on table public.art_split_schedules is
  'The post-recoupment percentage split of record per scope_key — the founder''s example cut (50% artist / 30% gallery / 20% master printmaker) and the sculpture''s studio-assistant and co-creator releases. contributors is the jsonb roster of ArtSplitContributorSpec rows. UNIQUE (scope_key): a re-registration replaces the row atomically and increments version; accrued cuts keep their version''s event ids — history, never re-cut.';

-- ---------------------------------------------------------------------------
-- art_split_accruals: the append-only accrual ledger — allocations is the
-- jsonb array of per-payee designated shares ({ payee_id, payee_name,
-- share_cents }); dust_cents is the visible sub-cent residue of a
-- percentage cut (conservation: allocations + dust = basis, exact).
-- UNIQUE (schedule_id, source_event_id) is the once-only guard.
-- ---------------------------------------------------------------------------
create table if not exists public.art_split_accruals (
  id              uuid primary key default gen_random_uuid(),
  schedule_id     uuid not null,
  scope_key       text not null,
  scope           text not null,
  source_event_id text not null,
  basis_cents     integer not null,
  allocations     jsonb not null,
  dust_cents      integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (schedule_id, source_event_id),
  constraint art_split_accruals_schedule_fk
    foreign key (schedule_id) references public.art_split_schedules (id)
    on delete cascade,
  constraint art_split_accruals_scope_check
    check (scope in ('print_edition', 'sculpture_fabrication')),
  constraint art_split_accruals_basis_check
    check (basis_cents >= 0),
  constraint art_split_accruals_dust_check
    check (dust_cents >= 0)
);

create index if not exists art_split_accruals_schedule_idx
  on public.art_split_accruals (schedule_id);

comment on table public.art_split_accruals is
  'The append-only post-recoupment split ledger: one row per (schedule, funding event) — the excess that flowed past the fabrication debt sequence, divided per the schedule of record. allocations + dust_cents = basis_cents, exact: nothing rounds up into a contributor''s credit. UNIQUE (schedule_id, source_event_id): the once-only guard — the unique violation IS the replay signal.';

-- ---------------------------------------------------------------------------
-- art_licensing_agency_policies: the copyright agency's collection-fee
-- rate of record per agency_code — ARS and DACS, CONFIGURABLE inside the
-- founder's 15–20% band, CHECK-enforced at rest here and lane-enforced
-- at write (the 0031 book_returns_reserve_policies band discipline).
-- ---------------------------------------------------------------------------
create table if not exists public.art_licensing_agency_policies (
  id                 uuid primary key default gen_random_uuid(),
  agency_code        text not null,
  agency_name        text not null,
  collection_fee_bps integer not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (agency_code),
  constraint art_licensing_agency_policies_agency_check
    check (agency_code in ('ars', 'dacs')),
  constraint art_licensing_agency_policies_fee_check
    check (collection_fee_bps >= 1500 and collection_fee_bps <= 2000)
);

comment on table public.art_licensing_agency_policies is
  'The copyright agency collection-fee rate of record per agency_code (ARS, DACS): collection_fee_bps whole basis points in [1500, 2000] — 15% to 20%, configurable inside the founder band. UNIQUE (agency_code): a re-registered policy replaces the row atomically. The museum licensing row''s applied fee is validated against the same band at parse; the policy is the administration''s registered rate.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all policies with a full service-role grant — the 0017–0031
-- precedent. Client roles read nothing; workers use the service role.
-- ---------------------------------------------------------------------------
alter table public.art_recoupment_pools enable row level security;
alter table public.art_recoupment_applications enable row level security;
alter table public.art_split_schedules enable row level security;
alter table public.art_split_accruals enable row level security;
alter table public.art_licensing_agency_policies enable row level security;

drop policy if exists art_recoupment_pools_service_role_all
  on public.art_recoupment_pools;
create policy art_recoupment_pools_service_role_all
  on public.art_recoupment_pools
  for all
  using (false)
  with check (false);

drop policy if exists art_recoupment_applications_service_role_all
  on public.art_recoupment_applications;
create policy art_recoupment_applications_service_role_all
  on public.art_recoupment_applications
  for all
  using (false)
  with check (false);

drop policy if exists art_split_schedules_service_role_all
  on public.art_split_schedules;
create policy art_split_schedules_service_role_all
  on public.art_split_schedules
  for all
  using (false)
  with check (false);

drop policy if exists art_split_accruals_service_role_all
  on public.art_split_accruals;
create policy art_split_accruals_service_role_all
  on public.art_split_accruals
  for all
  using (false)
  with check (false);

drop policy if exists art_licensing_agency_policies_service_role_all
  on public.art_licensing_agency_policies;
create policy art_licensing_agency_policies_service_role_all
  on public.art_licensing_agency_policies
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.art_recoupment_pools to service_role;
grant select, insert, update, delete on public.art_recoupment_applications to service_role;
grant select, insert, update, delete on public.art_split_schedules to service_role;
grant select, insert, update, delete on public.art_split_accruals to service_role;
grant select, insert, update, delete on public.art_licensing_agency_policies to service_role;

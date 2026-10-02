-- =============================================================================
-- 0024 — Webtoon studio splits + per-language translation cascades (PR 20)
--
-- The contract layer the webtoon studio-split and translation-cascade
-- planners read:
--
--   webtoon_studio_split_roles          <- listWebtoonStudioSplitRoles /
--                                          buildWebtoonStudioSplitPlan
--     (the per-series production split schedule: one row per
--      series/role-group/payee; group bands are cross-row group totals
--      enforced at plan time, fail-closed)
--   webtoon_localization_contracts      <- getWebtoonLocalizationContract /
--                                          buildTranslationCascadePlan
--     (one localizer of record per (series, language) feed — flat fee per
--      chapter or fractional revenue share, per contract)
--   webtoon_localization_cost_schedules <- the immutable amortization
--      contract (the VTuber tech-setup discipline, migration 0020)
--   webtoon_localization_cost_lines     <- the append-only consumed lines,
--      unique per (schedule_ref, line_index) — the insert-as-lock guard
--   webtoon_recoupment_pools            <- one pool of record per
--      (series, class): print_advance and digital_coin_unlock are SEPARATE
--      pools — the physical print advance never recoups against digital
--      chapter coin unlocks (the isolation rule)
--   webtoon_recoupment_applications     <- the append-only recovery log,
--      unique per (pool_id, source_event_id) — the once-only replay guard
--
-- Series identity: webtoon series arrive from statement feeds (the recon
-- lane's seriesId), not the asset registry — series_id is text, matching
-- the queue's recorded value. The only FK is the pool's self-reference
-- (applications -> pools, uuid -> uuid, type-matched).
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with a full service-role grant (the 0017–0022
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- webtoon_studio_split_roles: the per-series production split schedule.
-- One row per (series, role_group, payee). The role-group bands (original
-- creator/storywriter 30–40% of net, line artist/inker 20–30%, colorist/
-- background 10–15%) are cross-row group totals no per-row constraint can
-- express — the planner enforces them fail-closed and refuses an
-- out-of-band registry. Allocations within a group follow insertion_order.
-- ---------------------------------------------------------------------------
create table if not exists public.webtoon_studio_split_roles (
  id             uuid primary key default gen_random_uuid(),
  series_id      text not null,
  role_group     text not null,
  payee_id       text not null,
  payee_name     text not null,
  share_bps      integer not null,
  contract_ref   text not null,
  created_at     timestamptz not null default now(),
  insertion_order bigint generated always as identity,
  unique (series_id, role_group, payee_id),
  constraint webtoon_studio_split_roles_role_group_check
    check (role_group in (
      'original_creator_storywriter',
      'line_artist_inker',
      'colorist_background'
    )),
  constraint webtoon_studio_split_roles_share_bps_check
    check (share_bps > 0 and share_bps <= 10000)
);

create index if not exists webtoon_studio_split_roles_series_order_idx
  on public.webtoon_studio_split_roles (series_id, insertion_order);

comment on table public.webtoon_studio_split_roles is
  'Per-series webtoon production split schedule: one row per series/role-group/payee. Role-group band totals (30–40 / 20–30 / 10–15 bps-percent of net) are cross-row group totals enforced at plan time, fail-closed. insertion_order is the deterministic allocation order within a group.';

-- ---------------------------------------------------------------------------
-- webtoon_localization_contracts: the localizer of record per language feed.
-- One row per (series, language). fee_mode picks the royalty shape: a flat
-- per-chapter fee (per_chapter_flat_fee_cents) or a fractional revenue
-- share of the language feed's net (rev_share_bps). Re-registering a
-- contract replaces the row atomically (upsert on the composite key).
-- ---------------------------------------------------------------------------
create table if not exists public.webtoon_localization_contracts (
  id                        uuid primary key default gen_random_uuid(),
  series_id                 text not null,
  language_code             text not null,
  localizer_payee_id        text not null,
  localizer_payee_name      text not null,
  fee_mode                  text not null,
  per_chapter_flat_fee_cents integer not null default 0,
  rev_share_bps             integer not null default 0,
  contract_ref              text not null,
  created_at                timestamptz not null default now(),
  unique (series_id, language_code),
  constraint webtoon_localization_contracts_fee_mode_check
    check (fee_mode in ('flat_fee', 'rev_share')),
  constraint webtoon_localization_contracts_flat_fee_check
    check (per_chapter_flat_fee_cents >= 0),
  constraint webtoon_localization_contracts_rev_share_check
    check (rev_share_bps >= 0 and rev_share_bps <= 10000)
);

comment on table public.webtoon_localization_contracts is
  'One localizer of record per (series, language) feed: flat per-chapter fee or fractional revenue share of that feed''s net, per contract. The translation cascade pays this localizer BEFORE the primary author''s remaining net.';

-- ---------------------------------------------------------------------------
-- webtoon_localization_cost_schedules / _lines: the translation cost
-- amortization discipline (the VTuber tech-setup precedent, migration 0020).
-- The schedule row is the immutable contract; the consumed LINES are
-- append-only and unique per (schedule_ref, line_index) — a release
-- consumes the next period by inserting its line; a concurrent consume of
-- the same period loses on the unique violation.
-- ---------------------------------------------------------------------------
create table if not exists public.webtoon_localization_cost_schedules (
  id                   uuid primary key default gen_random_uuid(),
  schedule_ref         text not null unique,
  series_id            text not null,
  language_code        text not null,
  total_cost_cents     integer not null,
  amortization_periods integer not null,
  cost_agreement_ref   text not null,
  created_at           timestamptz not null default now(),
  constraint webtoon_localization_cost_schedules_total_check
    check (total_cost_cents > 0),
  constraint webtoon_localization_cost_schedules_periods_check
    check (amortization_periods > 0)
);

comment on table public.webtoon_localization_cost_schedules is
  'Immutable translation-cost amortization contract: total cost split over N periods for one (series, language) feed. The escrow release consumes periods in order via the lines table.';

create table if not exists public.webtoon_localization_cost_lines (
  id                    uuid primary key default gen_random_uuid(),
  schedule_ref          text not null,
  line_index            integer not null,
  amount_cents          integer not null,
  released_in_ledger_id text not null,
  created_at            timestamptz not null default now(),
  unique (schedule_ref, line_index),
  constraint webtoon_localization_cost_lines_amount_check
    check (amount_cents > 0)
);

create index if not exists webtoon_localization_cost_lines_ref_idx
  on public.webtoon_localization_cost_lines (schedule_ref, line_index);

comment on table public.webtoon_localization_cost_lines is
  'Append-only consumed amortization lines, unique per (schedule_ref, line_index) — the insert-as-lock guard. released_in_ledger_id is the settled ledger transaction that consumed the period.';

-- ---------------------------------------------------------------------------
-- webtoon_recoupment_pools / _applications: the recoupment isolation.
-- print_advance and digital_coin_unlock are separate pools of record per
-- (series, class): a physical print advance recoups ONLY from print
-- revenue, digital chapter coin unlocks ONLY from coin revenue — no
-- cross-collateralization (the film territory firewall's isolation rule,
-- applied to webtoon advances). Applications are append-only and unique
-- per (pool_id, source_event_id) — a replayed application is the unique
-- violation, never a double recovery.
-- ---------------------------------------------------------------------------
create table if not exists public.webtoon_recoupment_pools (
  id                    uuid primary key default gen_random_uuid(),
  series_id             text not null,
  pool_class            text not null,
  advance_cents         integer not null,
  recouped_cents        integer not null default 0,
  currency              text not null,
  status                text not null,
  advance_agreement_ref text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (series_id, pool_class),
  constraint webtoon_recoupment_pools_class_check
    check (pool_class in ('print_advance', 'digital_coin_unlock')),
  constraint webtoon_recoupment_pools_advance_check
    check (advance_cents > 0),
  constraint webtoon_recoupment_pools_recouped_check
    check (recouped_cents >= 0),
  constraint webtoon_recoupment_pools_status_check
    check (status in ('active', 'recouped'))
);

comment on table public.webtoon_recoupment_pools is
  'Recoupment pools of record per (series, class): print_advance and digital_coin_unlock stay isolated — no cross-collateralization between physical print advances and digital chapter coin unlocks. recouped_cents is the derived SUM of the applications.';

create table if not exists public.webtoon_recoupment_applications (
  id                   uuid primary key default gen_random_uuid(),
  pool_id              uuid not null references public.webtoon_recoupment_pools (id),
  pool_class           text not null,
  source_event_id      text not null,
  recouped_before_cents integer not null,
  applied_cents        integer not null,
  remaining_cents      integer not null,
  created_at           timestamptz not null default now(),
  unique (pool_id, source_event_id),
  unique (pool_id, recouped_before_cents),
  constraint webtoon_recoupment_applications_class_check
    check (pool_class in ('print_advance', 'digital_coin_unlock')),
  constraint webtoon_recoupment_applications_applied_check
    check (applied_cents > 0),
  constraint webtoon_recoupment_applications_remaining_check
    check (remaining_cents >= 0)
);

create index if not exists webtoon_recoupment_applications_pool_idx
  on public.webtoon_recoupment_applications (pool_id, created_at);

comment on table public.webtoon_recoupment_applications is
  'Append-only recoupment applications, unique per (pool_id, source_event_id) — the once-only replay guard — and unique per (pool_id, recouped_before_cents) — the insert-as-lock POSITION arbiter for concurrent applications (the PR 12/PR 99 discipline). applied_cents is the exact integer recovery from one revenue event; recouped_before_cents the pool position it applied at; remaining_cents the pool balance after it.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all (every policy false). Service role bypasses RLS; the
-- explicit grant keeps the "denied by RLS" audit surface the schema job
-- checks.
-- ---------------------------------------------------------------------------

alter table public.webtoon_studio_split_roles enable row level security;
alter table public.webtoon_localization_contracts enable row level security;
alter table public.webtoon_localization_cost_schedules enable row level security;
alter table public.webtoon_localization_cost_lines enable row level security;
alter table public.webtoon_recoupment_pools enable row level security;
alter table public.webtoon_recoupment_applications enable row level security;

drop policy if exists webtoon_studio_split_roles_service_role_all
  on public.webtoon_studio_split_roles;
create policy webtoon_studio_split_roles_service_role_all
  on public.webtoon_studio_split_roles
  for all
  using (false)
  with check (false);

drop policy if exists webtoon_localization_contracts_service_role_all
  on public.webtoon_localization_contracts;
create policy webtoon_localization_contracts_service_role_all
  on public.webtoon_localization_contracts
  for all
  using (false)
  with check (false);

drop policy if exists webtoon_localization_cost_schedules_service_role_all
  on public.webtoon_localization_cost_schedules;
create policy webtoon_localization_cost_schedules_service_role_all
  on public.webtoon_localization_cost_schedules
  for all
  using (false)
  with check (false);

drop policy if exists webtoon_localization_cost_lines_service_role_all
  on public.webtoon_localization_cost_lines;
create policy webtoon_localization_cost_lines_service_role_all
  on public.webtoon_localization_cost_lines
  for all
  using (false)
  with check (false);

drop policy if exists webtoon_recoupment_pools_service_role_all
  on public.webtoon_recoupment_pools;
create policy webtoon_recoupment_pools_service_role_all
  on public.webtoon_recoupment_pools
  for all
  using (false)
  with check (false);

drop policy if exists webtoon_recoupment_applications_service_role_all
  on public.webtoon_recoupment_applications;
create policy webtoon_recoupment_applications_service_role_all
  on public.webtoon_recoupment_applications
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.webtoon_studio_split_roles to service_role;
grant select, insert, update, delete on public.webtoon_localization_contracts to service_role;
grant select, insert, update, delete on public.webtoon_localization_cost_schedules to service_role;
grant select, insert, update, delete on public.webtoon_localization_cost_lines to service_role;
grant select, insert, update, delete on public.webtoon_recoupment_pools to service_role;
grant select, insert, update, delete on public.webtoon_recoupment_applications to service_role;

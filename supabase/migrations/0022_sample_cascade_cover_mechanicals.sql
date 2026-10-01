-- =============================================================================
-- 0022 — Music sample cascade + statutory cover mechanicals (PR 17)
--
-- The contract layer the sample cascade and cover mechanical planners read:
--
--   sample_clearance_edges  <- loadSampleClearanceEdgeMap / buildSampleCascadePlan
--     (one row per clearance agreement: a work's licensed use of an upstream
--      composition, the licensor of record, and the extracted license
--      percentage in bps)
--   composition_publishers  <- listCompositionPublishers / buildCoverMechanicalPlan
--     (the publishers of record per composition; a cover version routes the
--      statutory mechanical pool here BEFORE the recording artist)
--
-- The walk key is match_queue.parent_composition_id (addendum 6, migration
-- 0011): work_id and parent_composition_id are cbt_assets ids, so both
-- columns carry type-matched guarded FKs (uuid -> cbt_assets.id).
--
-- The rights-type separation: master and publishing are separate sides of the
-- queue; an edge belongs to one side and a line's cascade fires only its own
-- side's edges.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with a full service-role grant (the 0017/0019/0020/0021
-- precedent): client roles read nothing; UCT/CVT use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- sample_clearance_edges: the clearance agreement of record.
-- (work_id -> parent_composition_id) is one licensed dependency; multi-sample
-- chains and diamonds are trees of these edges. A work may sample the same
-- parent on both sides of the rights separation — rights_type joins the
-- uniqueness key.
-- ---------------------------------------------------------------------------
create table if not exists public.sample_clearance_edges (
  id                      uuid primary key default gen_random_uuid(),
  work_id                 uuid not null references public.cbt_assets (id),
  parent_composition_id   uuid not null references public.cbt_assets (id),
  rights_type             text not null,
  rights_holder_payee_id  text not null,
  rights_holder_payee_name text not null,
  license_bps             integer not null,
  clearance_agreement_ref text not null,
  created_at              timestamptz not null default now(),
  insertion_order         bigint generated always as identity,
  unique (work_id, parent_composition_id, rights_holder_payee_id, rights_type),
  constraint sample_clearance_edges_rights_type_check
    check (rights_type in ('master', 'publishing')),
  constraint sample_clearance_edges_license_bps_check
    check (license_bps > 0 and license_bps <= 10000),
  constraint sample_clearance_edges_no_self_edge
    check (work_id <> parent_composition_id)
);

create index if not exists sample_clearance_edges_work_id_order_idx
  on public.sample_clearance_edges (work_id, insertion_order);
create index if not exists sample_clearance_edges_parent_idx
  on public.sample_clearance_edges (parent_composition_id);

comment on table public.sample_clearance_edges is
  'Clearance agreements of record: work_id''s licensed use of parent_composition_id on one side of the rights separation, the licensor payee, and the license percentage in bps extracted from the agreement (clearance_agreement_ref). insertion_order is the deterministic reservation order. License bps exceeding the line (sum > 10000 on a walk) is refused at plan time, not here — the walk is cross-row.';

-- ---------------------------------------------------------------------------
-- composition_publishers: the publishers of record per composition.
-- A cover version routes the statutory mechanical pool to these publishers
-- directly, by share, before the recording artist. The shares are the
-- publishers'' splits of the mechanical pool and must sum to exactly 10000 —
-- a cross-row sum no per-row constraint can express, so the planner enforces
-- it fail-closed and refuses an unbalanced registry.
-- ---------------------------------------------------------------------------
create table if not exists public.composition_publishers (
  id                  uuid primary key default gen_random_uuid(),
  composition_id      uuid not null references public.cbt_assets (id),
  publisher_payee_id  text not null,
  publisher_payee_name text not null,
  share_bps           integer not null,
  created_at          timestamptz not null default now(),
  insertion_order     bigint generated always as identity,
  unique (composition_id, publisher_payee_id),
  constraint composition_publishers_share_bps_check
    check (share_bps > 0 and share_bps <= 10000)
);

create index if not exists composition_publishers_composition_idx
  on public.composition_publishers (composition_id, insertion_order);

comment on table public.composition_publishers is
  'Publishers of record per composition: the statutory cover mechanical pool routes here directly, by share, before the recording artist. Shares must sum to exactly 10000 per composition — enforced at plan time (cross-row), planner refuses an unbalanced registry.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all (every policy false). Service role bypasses RLS; the explicit
-- grant keeps the "denied by RLS" audit surface the schema job checks.
-- ---------------------------------------------------------------------------

alter table public.sample_clearance_edges enable row level security;
alter table public.composition_publishers enable row level security;

drop policy if exists sample_clearance_edges_service_role_all
  on public.sample_clearance_edges;
create policy sample_clearance_edges_service_role_all
  on public.sample_clearance_edges
  for all
  using (false)
  with check (false);

drop policy if exists composition_publishers_service_role_all
  on public.composition_publishers;
create policy composition_publishers_service_role_all
  on public.composition_publishers
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.sample_clearance_edges to service_role;
grant select, insert, update, delete on public.composition_publishers to service_role;

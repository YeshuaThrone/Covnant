-- ---------------------------------------------------------------------------
-- Migration 0018 — gaming engine-royalty accumulator + item splits (Deep
-- Royalties PR 12, todo_lLOMfj8M).
--
-- The three tables the gaming lane owns:
--
--   gaming_engine_royalty_events — the Epic-family engine-royalty
--     accumulator's append-only contribution log. The accumulator's state
--     is the DERIVED sum of these rows for a (platform, product, year) —
--     never a mutable counter — so a replayed ingest re-derives the same
--     event_id and the UNIQUE constraint turns the contribution into a
--     counted no-op: replayed gross can never cross the $1M annual
--     threshold twice. Each row also records the line's own
--     engine_royalty_micros AT CONTRIBUTION TIME (0 while under the
--     threshold, 3.5% of the above-threshold marginal once crossed, 0 for
--     waived Epic Games Store sales) — a replay that re-derives the queue
--     row reuses the recorded value instead of recomputing against moved
--     state.
--
--   gaming_item_split_schedules — the registered per-item routing (jsonb
--     splits): the founder gaming directive's per-contract primary-sale
--     splits (a studio lead 50 / 3D modeler 30 / audio designer 20 deal
--     while the next item pays a different sheet entirely). ONE validated
--     schedule per item; the TypeScript module
--     (src/workers/recon/gamingSplits.ts) is the registration gate —
--     share_bps must sum to EXACTLY 10000 (100.0000%); rows are what
--     passed it, versioned monotonically per re-registration.
--
--   gaming_split_payouts — the routing-decision record for ONE holding
--     credit. One row per funding queue event (unique on source_event_id):
--     on a secondary resale the recorded royalty routed to the original-
--     creator payee off the top, and the per-payee integer-cent accruals
--     route the remainder (floor shares, remainder swept as company dust —
--     allocations plus royalty plus dust equals the routed net). A replayed
--     ingest re-derives the same source_event_id and the UNIQUE constraint
--     turns the replay into a counted no-op — the PR #93 per-source guard
--     pattern.
--
-- ADDITIVE migration at the next-free number (0011-0017 are taken). Nothing
-- existing is dropped or altered. House pattern (0006/0010/0011/0017):
-- check-constrained vocabulary, RLS deny-all, full service_role grant,
-- insertion_order bigint. This file is idempotent — CI applies it twice;
-- every object uses IF NOT EXISTS.
-- ---------------------------------------------------------------------------

create table if not exists public.gaming_engine_royalty_events (
  id                   uuid primary key default gen_random_uuid(),
  -- match_queue.event_id is TEXT (0007) — the FK must match the referenced
  -- column's type exactly (the 0011/0017 precedent).
  event_id             text not null unique,
  platform             text not null
                       check (platform in ('epic_games_store', 'unreal_marketplace')),
  product_id           text not null,
  annual_year         integer not null check (annual_year >= 2020),
  gross_micros         text not null,
  engine_royalty_micros text not null,
  created_at           timestamptz not null default now(),
  insertion_order      bigint generated always as identity
);

comment on table public.gaming_engine_royalty_events is
  'Gaming engine royalty (PR 12): the Epic-family accumulator''s append-only contribution log — one row per contributing queue event. The per-product annual state is the DERIVED sum of these rows, never a mutable counter, so replayed gross can never cross the $1M threshold twice.';
comment on column public.gaming_engine_royalty_events.event_id is
  'The contributing queue event — match_queue.event_id (`recon:`; 0007), the same id the holding credit carries as its journal ref. UNIQUE: one contribution per event, ever; a replayed ingest is a counted no-op.';
comment on column public.gaming_engine_royalty_events.platform is
  'The Epic-family storefront that sold the line — epic_games_store (the engine royalty is WAIVED there) or unreal_marketplace (the 3.5% royalty applies above the annual threshold).';
comment on column public.gaming_engine_royalty_events.product_id is
  'The Epic product (App/Project ID) the accumulator is scoped to — the $1M threshold is per product per annual year.';
comment on column public.gaming_engine_royalty_events.annual_year is
  'The accumulator''s UTC annual year — the $1M threshold''s bucket, taken from the line''s sale date.';
comment on column public.gaming_engine_royalty_events.gross_micros is
  'The line''s gross contribution, fixed-point micros as text — never a float.';
comment on column public.gaming_engine_royalty_events.engine_royalty_micros is
  'The line''s own engine royalty at contribution time, micros as text — 0 while the product''s annual gross is under the $1M threshold, 3.5% of the above-threshold marginal once crossed, 0 for waived Epic Games Store sales. A replay reuses the recorded value instead of recomputing against moved state.';

create table if not exists public.gaming_item_split_schedules (
  item_id               text primary key,
  asset_cbt_code        text,
  splits                jsonb not null,
  resale_royalty_payee_id text,
  version               bigint not null default 1 check (version >= 1),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.gaming_item_split_schedules is
  'Gaming item splits (PR 12): the registered per-item routing — one validated split schedule per item, stored jsonb. The TypeScript engine is the registration gate (share_bps must sum to exactly 10000 bps); rows are what passed it.';
comment on column public.gaming_item_split_schedules.item_id is
  'The platform item the schedule routes for — the ingest payload''s gaming itemId. One schedule per item; a re-registration replaces the row and bumps the version.';
comment on column public.gaming_item_split_schedules.asset_cbt_code is
  'The vault asset the item maps to (matched_cbt_code), when known — provenance, not routing state.';
comment on column public.gaming_item_split_schedules.splits is
  'The per-payee routing: payee_id, payee_name, role, and share_bps per holder. Sum must be EXACTLY 10000 bps (100.0000%) — validated at registration and re-validated at every accrual.';
comment on column public.gaming_item_split_schedules.resale_royalty_payee_id is
  'The original-creator payee for the secondary-resale royalty (the 5-10% platform creator fee). Required when the item''s contract enables secondary resale — a secondary line against a schedule without one fails the accrual, never silently unattributed money.';
comment on column public.gaming_item_split_schedules.version is
  'Monotonic registration version — bumped on every accepted re-registration. Existing payout routings keep the version they were computed against; history is never rewritten.';

create table if not exists public.gaming_split_payouts (
  id                  uuid primary key default gen_random_uuid(),
  item_id             text not null,
  source_event_id     text not null unique,
  source_amount_cents bigint not null default 0 check (source_amount_cents >= 0),
  resale_royalty_payee_id text,
  resale_royalty_cents bigint not null default 0 check (resale_royalty_cents >= 0),
  split_version       bigint not null check (split_version >= 1),
  accruals            jsonb not null,
  company_dust_cents  bigint not null default 0 check (company_dust_cents >= 0),
  created_at          timestamptz not null default now(),
  insertion_order     bigint generated always as identity
);

comment on table public.gaming_split_payouts is
  'Gaming item splits (PR 12): the routing-decision record for ONE holding credit — on a secondary resale the original-creator royalty routes off the top and the per-payee accruals route the remainder (floor shares, remainder swept as company dust). Royalty plus allocations plus dust equals the routed net, always.';
comment on column public.gaming_split_payouts.source_event_id is
  'The funding queue event — match_queue.event_id (`recon:`; 0007), the same id the holding credit carries as its line_item_id and journal ref. UNIQUE: one routing per funding event, ever; a replayed ingest is a counted no-op.';
comment on column public.gaming_split_payouts.source_amount_cents is
  'The line''s creator net that was routed, integer cents (gross minus the platform commission and engine royalty the posting pass already deducted).';
comment on column public.gaming_split_payouts.resale_royalty_cents is
  'The original-creator royalty routed off the top on a secondary sale, integer cents (0 on primary sales). The rate is the 5-10% band the row itself reported, validated at parse.';
comment on column public.gaming_split_payouts.accruals is
  'The per-payee integer-cent accruals of the remainder: payee_id, payee_name, role, amount_cents each — floor shares with the remainder swept as company dust.';
comment on column public.gaming_split_payouts.company_dust_cents is
  'The integer-cent dust the sweep routed to the platform variance account — royalty + sum(accruals) + dust === source_amount_cents.';

-- The accumulator's SUM reads one product-year; the item's payout history
-- reads routing order (oldest first).
create index if not exists idx_gaming_engine_royalty_events_product_year
  on public.gaming_engine_royalty_events (platform, product_id, annual_year);
create index if not exists idx_gaming_split_payouts_item
  on public.gaming_split_payouts (item_id, created_at);

-- ---------------------------------------------------------------------------
-- Foreign keys: the engine contribution and the split payout both hang off
-- their funding queue row (neither can exist without its funding event —
-- the per-source guard made structural). match_queue.event_id is TEXT not
-- null unique (0007) — the FK matches the referenced column's type exactly
-- (the 0011/0017 precedent).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.gaming_engine_royalty_events'::regclass
      and conname = 'fk_gaming_engine_royalty_events_source_event'
  ) then
    alter table public.gaming_engine_royalty_events
      add constraint fk_gaming_engine_royalty_events_source_event
      foreign key (event_id) references public.match_queue (event_id);
  end if;
  if not exists (
    select from pg_constraint
    where conrelid = 'public.gaming_split_payouts'::regclass
      and conname = 'fk_gaming_split_payouts_source_event'
  ) then
    alter table public.gaming_split_payouts
      add constraint fk_gaming_split_payouts_source_event
      foreign key (source_event_id) references public.match_queue (event_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Authorization: RLS deny-all (no policies) + full service-role grants, the
-- migrations 0001-0017 convention. The store seam is the only writer; the
-- posting pass and the payout gates are the only readers.
-- ---------------------------------------------------------------------------

alter table public.gaming_engine_royalty_events enable row level security;
alter table public.gaming_item_split_schedules enable row level security;
alter table public.gaming_split_payouts enable row level security;
grant all on public.gaming_engine_royalty_events to service_role;
grant all on public.gaming_item_split_schedules to service_role;
grant all on public.gaming_split_payouts to service_role;

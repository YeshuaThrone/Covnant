-- =============================================================================
-- 0026 — Merchandise COGS + the brand collaboration waterfall (PR 22)
--
-- The contract + amortization layer the merch COGS engine and the collab
-- waterfall read:
--
--   merch_cogs_lots                        <- registerMerchCogsLot /
--                                             buildMerchFifoConsumptionPlan
--     (the production batch of record per (sku_id, lot_ref): the batch's
--      unit count and its per-unit production cost — the "raw production
--      debt" the FIFO engine amortizes; cogs_per_unit_cents is the lot's
--      OWN per-unit cost, because production batches of one sku price
--      differently — the amortization is keyed on sku_id AND cogs_per_unit)
--   merch_cogs_consumptions                <- releaseMerchCollabSettlement
--     (the append-only FIFO consumption truth, the webtoon localization
--      amortization line's discipline (0024) at unit scope: one row per
--      (lot, source fulfillment event), UNIQUE for the replay guard and
--      UNIQUE (lot_id, units_consumed_before) for the insert-as-lock
--      position arbiter — the PR 99/PR 12 discipline; the engine walks
--      lots oldest-first and never amortizes more than was produced)
--   merch_collab_agreements                <- getMerchCollabAgreement /
--                                             releaseMerchCollabSettlement
--     (the collab deal of record per sku: the manufacturing party, the
--      brand, the collaborating artist with their split in basis points,
--      and the fronted overhead amounts — blank sourcing and screen
--      printing — the waterfall's step-one recoupment targets)
--   merch_collab_recoupment_applications   <- applyMerchCollabRecoupment
--     (the append-only recoupment application ledger, the 0024 pool
--      discipline at agreement scope: UNIQUE (agreement_id, pool_class,
--      source_event_id) replays a guard and UNIQUE (agreement_id,
--      pool_class, recouped_before_cents) is the position lock; the
--      applications' sum is the running recovery, derived — never a
--      second mutable counter)
--   merch_designer_royalty_tiers           <- registerDesignerRoyaltyTier
--     (the flat per-unit royalty of record per sku — the guest designer's
--      e.g. $3.50 per garment tier)
--   merch_designer_royalty_billings        <- billDesignerRoyalty
--     (the per-unit royalty billed DIRECTLY to order fulfillment events:
--      one append-only billing row per (fulfillment event, sku) — the
--      UNIQUE pair is the replay guard; the billing is the state of
--      record at fulfillment processing time, never retroactive)
--   merch_consignment_settlements          <- the consignment lane's
--                                             posting pass
--     (the durable shrinkage reconciliation: the wholesale partner's
--      payout report row of record — gross, commission, the shrinkage/
--      loss allowance offset, and the verified net payout; the report's
--      own arithmetic must reconcile exactly or the row never exists)
--
-- Identity: merch sku ids arrive from the senders' transaction dumps (the
-- recon lane's recorded value, the optioned-work precedent) — sku_id is
-- text. FKs are guarded and type-matched: the consumption's lot reference
-- (uuid -> uuid), the recoupment application's agreement reference
-- (uuid -> uuid), and the royalty billing's tier reference (text -> text
-- UNIQUE) — a billing cannot exist for a sku with no registered tier,
-- which is exactly the billing's precondition (the tier is the state of
-- record at fulfillment time).
--
-- The founder's ordering, for the schema reader: the collab waterfall
-- (PR 22) recoups the manufacturing party FIRST — the FIFO unit
-- production debt and the two fronted overhead pools — and only then
-- splits net profits per contract. The ordering is enforced by
-- buildMerchCollabWaterfallPlan and the release lane's commit order
-- (plan-time + write-time, fail-closed); the schema carries the terms of
-- record.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with a full service-role grant (the 0017–0025
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- merch_cogs_lots: the production batch of record per (sku_id, lot_ref).
-- One row per production run of one sku: the units the run produced and
-- each unit's production cost. The FIFO engine consumes lots oldest-first
-- (created_at, then lot_ref) until a settlement's units are covered — the
-- "dynamic FIFO COGS amortization keyed on sku_id and cogs_per_unit".
-- ---------------------------------------------------------------------------
create table if not exists public.merch_cogs_lots (
  id                  uuid primary key default gen_random_uuid(),
  sku_id              text not null,
  lot_ref             text not null,
  units_produced      integer not null,
  cogs_per_unit_cents integer not null,
  created_at          timestamptz not null default now(),
  unique (sku_id, lot_ref),
  constraint merch_cogs_lots_units_check check (units_produced > 0),
  constraint merch_cogs_lots_cogs_check check (cogs_per_unit_cents >= 0)
);

create index if not exists merch_cogs_lots_sku_fifo_idx
  on public.merch_cogs_lots (sku_id, created_at, lot_ref);

comment on table public.merch_cogs_lots is
  'The merchandise production batch of record per (sku_id, lot_ref): units produced and the batch''s own per-unit production cost. The FIFO COGS engine amortizes lots oldest-first; cogs_per_unit_cents prices each lot''s consumption.';

-- ---------------------------------------------------------------------------
-- merch_cogs_consumptions: the append-only FIFO consumption truth. One row
-- per (lot, source fulfillment event): the units the event consumed, the
-- position it consumed from (units_consumed_before — the insert-as-lock
-- arbiter), the lot's per-unit cost at consumption, and the amortized
-- cents. The unique pairs are the replay guard and the position lock: a
-- replayed fulfillment event is the 23505, never a double amortization,
-- and two concurrent consumers of one lot compute the same position and
-- exactly one wins it — the loser re-derives from the append-only truth
-- (the webtoon localization amortization line's discipline, at unit
-- scope).
-- ---------------------------------------------------------------------------
create table if not exists public.merch_cogs_consumptions (
  id                    uuid primary key default gen_random_uuid(),
  lot_id                uuid not null,
  source_event_id       text not null,
  units_consumed_before integer not null,
  units_consumed        integer not null,
  cogs_per_unit_cents   integer not null,
  amortized_cents       integer not null,
  created_at            timestamptz not null default now(),
  unique (lot_id, source_event_id),
  unique (lot_id, units_consumed_before),
  constraint merch_cogs_consumptions_lot_fk
    foreign key (lot_id) references public.merch_cogs_lots (id)
    on delete cascade,
  constraint merch_cogs_consumptions_units_before_check
    check (units_consumed_before >= 0),
  constraint merch_cogs_consumptions_units_check
    check (units_consumed > 0),
  constraint merch_cogs_consumptions_cogs_check
    check (cogs_per_unit_cents >= 0),
  constraint merch_cogs_consumptions_amortized_check
    check (amortized_cents >= 0)
);

create index if not exists merch_cogs_consumptions_lot_idx
  on public.merch_cogs_consumptions (lot_id);

comment on table public.merch_cogs_consumptions is
  'The append-only FIFO consumption ledger: one row per (lot, source fulfillment event). UNIQUE (lot_id, source_event_id) is the replay guard; UNIQUE (lot_id, units_consumed_before) is the insert-as-lock position arbiter. The amortized cents route to the manufacturing party BEFORE any artist profit split releases.';

-- ---------------------------------------------------------------------------
-- merch_collab_agreements: the collab deal of record per sku (upsert on
-- sku_id — a re-registered agreement replaces the row atomically, the
-- localization-contract precedent). The manufacturing party is the
-- waterfall's step-one recovery holder — the FIFO unit production debt
-- AND 100% of the fronted blank-sourcing and screen-printing overhead;
-- the brand and the collaborating artist split what survives, the
-- artist's share in basis points of the post-recoupment remainder
-- (e.g. 5000 = 50/50).
-- ---------------------------------------------------------------------------
create table if not exists public.merch_collab_agreements (
  id                    uuid primary key default gen_random_uuid(),
  sku_id                text not null,
  manufacturer_payee_id   text not null,
  manufacturer_payee_name text not null,
  brand_payee_id        text not null,
  brand_payee_name      text not null,
  artist_payee_id       text not null,
  artist_payee_name     text not null,
  artist_split_bps      integer not null,
  blank_sourcing_cents  integer not null,
  screen_printing_cents integer not null,
  agreement_ref         text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (sku_id),
  constraint merch_collab_agreements_split_check
    check (artist_split_bps >= 0 and artist_split_bps <= 10000),
  constraint merch_collab_agreements_blank_check
    check (blank_sourcing_cents >= 0),
  constraint merch_collab_agreements_screen_check
    check (screen_printing_cents >= 0)
);

comment on table public.merch_collab_agreements is
  'The brand-collaboration deal of record per sku: the manufacturing party (the waterfall''s first-priority recovery holder), the brand, the collaborating artist with a basis-point split of the post-recoupment remainder, and the fronted overhead amounts (blank sourcing, screen printing) recouped 100% before any profit split. Upsert on sku_id.';

-- ---------------------------------------------------------------------------
-- merch_collab_recoupment_applications: the append-only recoupment ledger
-- over the agreement's two overhead pools. One row per (agreement,
-- pool_class, source settlement event): the pool position the application
-- took (recouped_before_cents), the cents applied, and the remainder.
-- The application sum IS the pool's recovery — derived from the
-- append-only truth, never a second mutable counter (the 0024 pool
-- discipline at agreement scope: the applications are the truth, the
-- position unique is the lock).
-- ---------------------------------------------------------------------------
create table if not exists public.merch_collab_recoupment_applications (
  id                     uuid primary key default gen_random_uuid(),
  agreement_id           uuid not null,
  pool_class             text not null,
  source_event_id        text not null,
  recouped_before_cents  integer not null,
  applied_cents          integer not null,
  remaining_cents        integer not null,
  created_at             timestamptz not null default now(),
  unique (agreement_id, pool_class, source_event_id),
  unique (agreement_id, pool_class, recouped_before_cents),
  constraint merch_collab_recoupment_applications_agreement_fk
    foreign key (agreement_id) references public.merch_collab_agreements (id)
    on delete cascade,
  constraint merch_collab_recoupment_applications_class_check
    check (pool_class in ('blank_sourcing', 'screen_printing')),
  constraint merch_collab_recoupment_applications_before_check
    check (recouped_before_cents >= 0),
  constraint merch_collab_recoupment_applications_applied_check
    check (applied_cents > 0),
  constraint merch_collab_recoupment_applications_remaining_check
    check (remaining_cents >= 0)
);

create index if not exists merch_collab_recoupment_applications_agreement_idx
  on public.merch_collab_recoupment_applications (agreement_id, pool_class);

comment on table public.merch_collab_recoupment_applications is
  'The append-only overhead-recoupment ledger over a collab agreement''s two pools (blank_sourcing, screen_printing): one row per (agreement, pool_class, source settlement event). The position unique is the insert-as-lock arbiter; the applications'' sum is the pool''s running recovery, and a pool whose recovery completes is spent — later settlements recoup nothing from it.';

-- ---------------------------------------------------------------------------
-- merch_designer_royalty_tiers: the flat per-unit royalty of record per
-- sku (upsert on sku_id). The guest designer's tier — e.g. 350 cents per
-- garment — is the state of record at fulfillment processing time; the
-- billing below prices each fulfillment event from THIS row.
-- ---------------------------------------------------------------------------
create table if not exists public.merch_designer_royalty_tiers (
  id                     uuid primary key default gen_random_uuid(),
  sku_id                 text not null,
  designer_payee_id      text not null,
  designer_payee_name    text not null,
  royalty_per_unit_cents integer not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (sku_id),
  constraint merch_designer_royalty_tiers_royalty_check
    check (royalty_per_unit_cents > 0)
);

comment on table public.merch_designer_royalty_tiers is
  'The design-IP royalty tier of record per sku: the guest designer''s flat per-unit royalty (e.g. 350 cents per garment). The state of record at fulfillment processing time — billings price fulfillment events from this row, never retroactively. Upsert on sku_id.';

-- ---------------------------------------------------------------------------
-- merch_designer_royalty_billings: the per-unit royalty billed DIRECTLY to
-- order fulfillment events. One append-only row per (fulfillment event,
-- sku): the units billed, the tier's per-unit royalty at billing time, and
-- the billed cents. UNIQUE (source_event_id, sku_id) is the replay guard —
-- a replayed fulfillment event is the 23505, never a double billing. The
-- FK guards the tier of record (text -> text UNIQUE, type-matched): a
-- billing cannot exist for a sku with no registered tier.
-- ---------------------------------------------------------------------------
create table if not exists public.merch_designer_royalty_billings (
  id                     uuid primary key default gen_random_uuid(),
  source_event_id        text not null,
  sku_id                 text not null,
  designer_payee_id      text not null,
  designer_payee_name    text not null,
  units_billed           integer not null,
  royalty_per_unit_cents integer not null,
  billed_cents           integer not null,
  created_at             timestamptz not null default now(),
  unique (source_event_id, sku_id),
  constraint merch_designer_royalty_billings_tier_fk
    foreign key (sku_id) references public.merch_designer_royalty_tiers (sku_id)
    on delete cascade,
  constraint merch_designer_royalty_billings_units_check
    check (units_billed > 0),
  constraint merch_designer_royalty_billings_royalty_check
    check (royalty_per_unit_cents > 0),
  constraint merch_designer_royalty_billings_billed_check
    check (billed_cents > 0)
);

create index if not exists merch_designer_royalty_billings_sku_idx
  on public.merch_designer_royalty_billings (sku_id);

comment on table public.merch_designer_royalty_billings is
  'The design-IP royalty billing ledger: one append-only row per (fulfillment event, sku) — units billed x the tier''s per-unit royalty, billed directly to the order fulfillment event. UNIQUE (source_event_id, sku_id) is the replay guard; the FK to the tier of record is the billing''s precondition.';

-- ---------------------------------------------------------------------------
-- merch_consignment_settlements: the wholesale consignment payout report
-- row of record — the durable shrinkage reconciliation. One row per
-- content-derived payout event: the period/location identity, the units
-- sold, the gross, the wholesale commission, the shrinkage/loss allowance
-- OFFSET, and the net payout the report must reconcile to exactly
-- (gross - commission - shrinkage = net payout, verified before the row
-- exists — a report whose rows do not reconcile is rejected whole).
-- ---------------------------------------------------------------------------
create table if not exists public.merch_consignment_settlements (
  id                       uuid primary key default gen_random_uuid(),
  event_id                 text not null,
  period                   text not null,
  location                 text not null,
  sku_id                   text not null,
  units_sold               integer not null,
  gross_cents              integer not null,
  commission_cents         integer not null,
  shrinkage_allowance_cents integer not null,
  net_payout_cents         integer not null,
  currency                 text not null,
  created_at               timestamptz not null default now(),
  unique (event_id),
  constraint merch_consignment_settlements_units_check
    check (units_sold > 0),
  constraint merch_consignment_settlements_gross_check
    check (gross_cents >= 0),
  constraint merch_consignment_settlements_commission_check
    check (commission_cents >= 0),
  constraint merch_consignment_settlements_shrinkage_check
    check (shrinkage_allowance_cents >= 0),
  constraint merch_consignment_settlements_net_check
    check (net_payout_cents >= 0)
);

create index if not exists merch_consignment_settlements_sku_idx
  on public.merch_consignment_settlements (sku_id);

comment on table public.merch_consignment_settlements is
  'The wholesale consignment payout row of record — the durable shrinkage reconciliation: gross, the wholesale commission, the shrinkage/loss allowance offset, and the net payout the report must reconcile to exactly (gross - commission - shrinkage). UNIQUE on the content-derived event id; a re-shipped report replays as the 23505, never a double settlement.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all (every policy false). Service role bypasses RLS; the
-- explicit grant keeps the "denied by RLS" audit surface the schema job
-- checks.
-- ---------------------------------------------------------------------------

alter table public.merch_cogs_lots enable row level security;
alter table public.merch_cogs_consumptions enable row level security;
alter table public.merch_collab_agreements enable row level security;
alter table public.merch_collab_recoupment_applications enable row level security;
alter table public.merch_designer_royalty_tiers enable row level security;
alter table public.merch_designer_royalty_billings enable row level security;
alter table public.merch_consignment_settlements enable row level security;

drop policy if exists merch_cogs_lots_service_role_all
  on public.merch_cogs_lots;
create policy merch_cogs_lots_service_role_all
  on public.merch_cogs_lots
  for all
  using (false)
  with check (false);

drop policy if exists merch_cogs_consumptions_service_role_all
  on public.merch_cogs_consumptions;
create policy merch_cogs_consumptions_service_role_all
  on public.merch_cogs_consumptions
  for all
  using (false)
  with check (false);

drop policy if exists merch_collab_agreements_service_role_all
  on public.merch_collab_agreements;
create policy merch_collab_agreements_service_role_all
  on public.merch_collab_agreements
  for all
  using (false)
  with check (false);

drop policy if exists merch_collab_recoupment_applications_service_role_all
  on public.merch_collab_recoupment_applications;
create policy merch_collab_recoupment_applications_service_role_all
  on public.merch_collab_recoupment_applications
  for all
  using (false)
  with check (false);

drop policy if exists merch_designer_royalty_tiers_service_role_all
  on public.merch_designer_royalty_tiers;
create policy merch_designer_royalty_tiers_service_role_all
  on public.merch_designer_royalty_tiers
  for all
  using (false)
  with check (false);

drop policy if exists merch_designer_royalty_billings_service_role_all
  on public.merch_designer_royalty_billings;
create policy merch_designer_royalty_billings_service_role_all
  on public.merch_designer_royalty_billings
  for all
  using (false)
  with check (false);

drop policy if exists merch_consignment_settlements_service_role_all
  on public.merch_consignment_settlements;
create policy merch_consignment_settlements_service_role_all
  on public.merch_consignment_settlements
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.merch_cogs_lots to service_role;
grant select, insert, update, delete on public.merch_cogs_consumptions to service_role;
grant select, insert, update, delete on public.merch_collab_agreements to service_role;
grant select, insert, update, delete on public.merch_collab_recoupment_applications to service_role;
grant select, insert, update, delete on public.merch_designer_royalty_tiers to service_role;
grant select, insert, update, delete on public.merch_designer_royalty_billings to service_role;
grant select, insert, update, delete on public.merch_consignment_settlements to service_role;

-- =============================================================================
-- 0027 — Merchandise returns reserve + fulfillment confirmation (PR 23)
--
-- The returns-protection layer the merch payout dispatch lane reads:
--
--   merch_return_reserve_policies    <- upsertMerchReturnReservePolicy /
--                                       the dispatch + release lanes
--     (the returns-protection deal of record per sku — upsert on sku_id,
--      the collab-agreement precedent: the founder-banded holdback rate
--      (10–15% in basis points), the founder-banded returns window (30–60
--      whole days), and the beneficiary payee of record the verified
--      release pays after the window. The terms come from the registry,
--      never the caller.)
--   merch_reserve_drawdowns          <- drawDownMerchReturnsReserve
--     (the append-only drawdown truth — the 0026 recoupment-application
--      discipline at reserve scope: one row per (reserve credit, source
--      return/chargeback event), UNIQUE (reserve_ledger_id,
--      source_event_id) as the replay guard — a re-shipped event is the
--      23505, never a double drawdown — and UNIQUE (reserve_ledger_id,
--      drawn_before_cents) as the insert-as-lock position arbiter — two
--      concurrent drawdowns of one reserve compute the same position and
--      exactly one wins it; the loser re-derives from the append-only
--      truth. The drawdowns' sum IS the reserve's spend — derived, never
--      a second mutable counter)
--   merch_fulfillment_trackings      <- insertMerchFulfillmentTracking /
--                                       resolveMerchFulfillmentState
--     (the fulfillment tracking events the merch payout gate reads — the
--      durable source of the physical_fulfillment_confirmed condition.
--      UNIQUE (fulfillment_event_id, tracking_number, tracking_state) is
--      the replay guard: a re-shipped tracking event is the 23505, never
--      a double record. Only 'delivered' confirms physical fulfillment;
--      'assigned' and 'in_transit' are honest not-yet states the gate
--      refuses, and an absent tracking ledger is an unknown that refuses
--      the same way — fail-closed by construction)
--
-- The reserve itself is NOT a new money table: a dispatched allocation's
-- holdback is a ledger_transactions row with kind AND status
-- 'merch_returns_reserve' — the holding-state sibling PR 7, PR 9, PR 13,
-- PR 15, and PR 20 shipped — so this migration, like the store contract,
-- never touches ledger_transactions (status/kind stay free text, the 0006
-- precedent every holding state shares).
--
-- Identity: merch sku ids arrive from the senders' transaction dumps (the
-- recon lane's recorded value, the 0026 precedent) — sku_id is text. The
-- drawdown's reserve reference is uuid -> uuid, type-matched (the 0026
-- FK discipline).
--
-- The founder's bands, for the schema reader: a holdback rate of 10–15%
-- of the allocation and a returns window of 30–60 days, CHECK-enforced at
-- rest here and lane-enforced at write — anything outside a band is a
-- hostile contract, refused.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with a full service-role grant (the 0017–0026
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- merch_return_reserve_policies: the returns-protection deal of record per
-- sku (upsert on sku_id — a re-registered policy replaces the money terms
-- atomically). reserve_rate_bps is whole basis points inside the founder
-- band (1000 = 10%, 1500 = 15%); reserve_window_days is whole days inside
-- the founder band (30–60). The beneficiary payee of record is the creator
-- the verified release pays after the window.
-- ---------------------------------------------------------------------------
create table if not exists public.merch_return_reserve_policies (
  id                     uuid primary key default gen_random_uuid(),
  sku_id                 text not null,
  reserve_rate_bps       integer not null,
  reserve_window_days    integer not null,
  beneficiary_payee_id   text not null,
  beneficiary_payee_name text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (sku_id),
  constraint merch_return_reserve_policies_rate_check
    check (reserve_rate_bps >= 1000 and reserve_rate_bps <= 1500),
  constraint merch_return_reserve_policies_window_check
    check (reserve_window_days >= 30 and reserve_window_days <= 60)
);

comment on table public.merch_return_reserve_policies is
  'The returns-protection deal of record per sku: the founder-banded holdback rate (10-15% in basis points), the founder-banded returns window (30-60 days), and the beneficiary payee of record the verified release pays after the window. Upsert on sku_id; the terms come from the registry, never the caller.';

-- ---------------------------------------------------------------------------
-- merch_reserve_drawdowns: the append-only drawdown truth. One row per
-- (reserve credit, source return/chargeback event): the drawdown class
-- (customer_return or chargeback), the reserve position the instant before
-- the drawdown (drawn_before_cents — the insert-as-lock arbiter), the
-- cents drawn, and the remaining cents. The drawdown sum IS the reserve's
-- spend — derived from the append-only truth, never a second mutable
-- counter (the 0026 recoupment-application discipline at reserve scope).
-- ---------------------------------------------------------------------------
create table if not exists public.merch_reserve_drawdowns (
  id                 uuid primary key default gen_random_uuid(),
  reserve_ledger_id  uuid not null,
  drawdown_class     text not null,
  source_event_id    text not null,
  drawn_before_cents integer not null,
  drawn_cents        integer not null,
  remaining_cents    integer not null,
  created_at         timestamptz not null default now(),
  unique (reserve_ledger_id, source_event_id),
  unique (reserve_ledger_id, drawn_before_cents),
  constraint merch_reserve_drawdowns_reserve_fk
    foreign key (reserve_ledger_id) references public.ledger_transactions (id)
    on delete cascade,
  constraint merch_reserve_drawdowns_class_check
    check (drawdown_class in ('customer_return', 'chargeback')),
  constraint merch_reserve_drawdowns_before_check
    check (drawn_before_cents >= 0),
  constraint merch_reserve_drawdowns_amount_check
    check (drawn_cents > 0),
  constraint merch_reserve_drawdowns_remaining_check
    check (remaining_cents >= 0)
);

create index if not exists merch_reserve_drawdowns_reserve_idx
  on public.merch_reserve_drawdowns (reserve_ledger_id);

comment on table public.merch_reserve_drawdowns is
  'The append-only returns-reserve drawdown ledger: one row per (reserve credit, source return/chargeback event). UNIQUE (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE (reserve_ledger_id, drawn_before_cents) is the insert-as-lock position arbiter. The drawdown sum is the reserve''s spend — derived, never a second mutable counter.';

-- ---------------------------------------------------------------------------
-- merch_fulfillment_trackings: the fulfillment tracking events the merch
-- payout gate reads. One row per (fulfillment event, tracking number,
-- tracking state): the carrier's lifecycle event as the fulfillment data
-- reports it. Only 'delivered' confirms physical fulfillment; the gate
-- resolves physical_fulfillment_confirmed from these rows and refuses on
-- absence (unknown) or a not-yet-delivered lifecycle — fail-closed.
-- ---------------------------------------------------------------------------
create table if not exists public.merch_fulfillment_trackings (
  id                   uuid primary key default gen_random_uuid(),
  fulfillment_event_id text not null,
  tracking_number      text not null,
  tracking_state       text not null,
  carrier              text not null,
  delivered_at         timestamptz,
  created_at           timestamptz not null default now(),
  unique (fulfillment_event_id, tracking_number, tracking_state),
  constraint merch_fulfillment_trackings_state_check
    check (tracking_state in ('assigned', 'in_transit', 'delivered'))
);

create index if not exists merch_fulfillment_trackings_event_idx
  on public.merch_fulfillment_trackings (fulfillment_event_id);

comment on table public.merch_fulfillment_trackings is
  'The fulfillment tracking events the merch payout gate reads: one row per (fulfillment event, tracking number, tracking state). UNIQUE (fulfillment_event_id, tracking_number, tracking_state) is the replay guard. Only delivered confirms physical fulfillment — assigned, in transit, and absence all refuse the gate, fail-closed.';

-- ---------------------------------------------------------------------------
-- Row-level security: deny-all with an explicit policy, so the
-- "denied by RLS" audit surface stays; the explicit grant keeps the
-- service-role write path.
-- ---------------------------------------------------------------------------

alter table public.merch_return_reserve_policies enable row level security;
alter table public.merch_reserve_drawdowns enable row level security;
alter table public.merch_fulfillment_trackings enable row level security;

drop policy if exists merch_return_reserve_policies_service_role_all
  on public.merch_return_reserve_policies;
create policy merch_return_reserve_policies_service_role_all
  on public.merch_return_reserve_policies
  for all
  using (false)
  with check (false);

drop policy if exists merch_reserve_drawdowns_service_role_all
  on public.merch_reserve_drawdowns;
create policy merch_reserve_drawdowns_service_role_all
  on public.merch_reserve_drawdowns
  for all
  using (false)
  with check (false);

drop policy if exists merch_fulfillment_trackings_service_role_all
  on public.merch_fulfillment_trackings;
create policy merch_fulfillment_trackings_service_role_all
  on public.merch_fulfillment_trackings
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.merch_return_reserve_policies to service_role;
grant select, insert, update, delete on public.merch_reserve_drawdowns to service_role;
grant select, insert, update, delete on public.merch_fulfillment_trackings to service_role;

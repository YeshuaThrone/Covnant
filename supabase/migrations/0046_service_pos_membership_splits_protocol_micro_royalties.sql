-- =============================================================================
-- 0046 — The service revenue lane: salon/med-spa franchise schedules,
--        per-treatment protocol micro-royalty policies, cross-location
--        redemption and membership-breakage splits, the distributor rebate
--        waterfall, booth-lease isolation, and the seven append-only
--        application ledgers of record (PR 42)
--
-- The founder service directive, per the brief. Thirteen tables:
--
--   service_franchise_schedules       <- upsertServiceFranchiseSchedule /
--                                        getServiceFranchiseSchedule
--     (one location's franchise contract terms of record: the master
--      franchisor royalty, the technician service commission, and the
--      house location margin — the founder's 5 / 45 / 50 example. The
--      three legs partition the gross EXACTLY: each 0–10000 bps and the
--      trio sums to 10000, pinned in CHECKs. UNIQUE per
--      salon_location_id: an upsert converges — the newest contract
--      governs the next split. ABSENT schedule = a counted fail-closed
--      skip — the walk never guesses a rate.)
--
--   service_protocol_policies         <- upsertServiceProtocolPolicy /
--                                        getServiceProtocolPolicy
--     (one protocol's per-treatment micro-fee of record: the protocol
--      creator payee — the master esthetician or celebrity dermatologist —
--      and the per-execution license fee in statement micros
--      (1 dollar = 1e8 micros) so sub-cent pricing stays exact. UNIQUE per
--      protocol_id: an upsert converges.)
--
--   service_redemption_policies       <- upsertServiceRedemptionPolicy /
--                                        getServiceRedemptionPolicy
--     (one home location's cross-location redemption split terms of
--      record: the franchisor royalty and home-location administrative
--      cut off a redemption's service allocation fee, each 0–10000 bps
--      and summing to AT MOST 10000 — the visiting location routes the
--      residual, so a past-10000 sum is refused. UNIQUE per
--      home_location_id: an upsert converges.)
--
--   service_breakage_policies         <- upsertServiceBreakagePolicy /
--                                        getServiceBreakagePolicy
--     (one home location's contractual breakage split terms of record:
--      the franchisor and franchisee shares of unredeemed monthly
--      subscription funds, each 0–10000 bps and summing to EXACTLY 10000
--      — the unredeemed funds allocate fully. UNIQUE per
--      home_location_id: an upsert converges.)
--
--   service_rebate_waterfalls         <- upsertServiceRebateWaterfallLeg /
--                                        listServiceRebateWaterfallLegs
--     (one location's rebate routing legs of record: the proportional
--      shares a distributor's volume rebate routes back through to
--      franchise location ledgers. UNIQUE per (salon_location_id,
--      ledger_id): a re-registered leg converges. Per-leg weights are
--      1–10000 bps; the location's full waterfall must sum to exactly
--      10000 bps — validated at read across the rows, the per-row CHECK
--      bounds the leg.)
--
--   service_booth_lease_policies      <- upsertServiceBoothLeasePolicy /
--                                        getServiceBoothLeasePolicy
--     (one hybrid salon's booth-lease terms of record: the studio owner
--      payee and the retail product sales commission rate — the weekly
--      flat chair rent routes around it. UNIQUE per salon_location_id:
--      an upsert converges.)
--
--   service_realization_applications  <- insertServiceRealizationApplication /
--                                        getServiceRealizationApplication
--     (the append-only Net Service Realization of record per service
--      ticket event: gross − backbar product COGS − card processing
--      engine cut − local service and sales taxes = the Net Realized
--      Service Pool, the identity pinned in a CHECK. A negative pool is
--      never dropped: verdict 'held_negative_net' pauses it visible, and
--      a 'paid' row is CHECK-pinned non-negative. UNIQUE per
--      source_event_id is the replay guard.)
--
--   service_franchise_split_applications
--                                     <- insertServiceFranchiseSplitApplication /
--                                        getServiceFranchiseSplitApplication
--     (the append-only three-way gross partition of record per ticket
--      event: royalty and commission are floored shares, the house margin
--      absorbs the floor dust as the residual — the arithmetic is pinned
--      in CHECKs. UNIQUE per source_event_id is the replay guard.)
--
--   service_protocol_micro_royalties  <- insertServiceProtocolMicroRoyalty /
--                                        getServiceProtocolMicroRoyalty
--     (the append-only per-treatment license fee of record — routed to
--      the protocol creator every time a franchised location logs the
--      branded treatment. One treatment per row: royalty_micros equals
--      the policy's micros_per_treatment and royalty_cents is its floored
--      cents — pinned. UNIQUE per source_event_id is the replay guard.)
--
--   service_redemption_split_applications
--                                     <- insertServiceRedemptionSplitApplication /
--                                        getServiceRedemptionSplitApplication
--     (the append-only cross-location redemption routing of record: the
--      franchisor royalty and home-admin cut are floored shares, the
--      visiting location routes the residual; home and visiting are
--      CHECK-pinned distinct — same-location redemptions are refused
--      upstream and never stored. UNIQUE per source_event_id is the
--      replay guard.)
--
--   service_breakage_allocations      <- insertServiceBreakageAllocation /
--                                        getServiceBreakageAllocation
--     (the append-only unredeemed-funds split of record: the franchisor
--      share is a floored share, the franchisee routes the residual —
--      pinned. UNIQUE per source_event_id is the replay guard.)
--
--   service_rebate_applications       <- insertServiceRebateApplication /
--                                        getServiceRebateApplication
--     (the append-only proportional rebate routing of record — the bulk
--      backbar purchasing kickback passed back to the location ledgers.
--      The routed total conserves the rebate exactly: routed_total =
--      volume_rebate is pinned, and the legs' largest-remainder shares
--      sum to it in the engine. UNIQUE per source_event_id is the replay
--      guard.)
--
--   service_booth_lease_applications  <- insertServiceBoothLeaseApplication /
--                                        getServiceBoothLeaseApplication
--     (the append-only isolated booth-lease legs of record: chair-rent
--      legs route the flat fee exact with a zero commission rate;
--      retail-commission legs route their floored commission — the
--      isolation is pinned in a two-branch CHECK. UNIQUE per
--      source_event_id is the replay guard.)
--
-- The 0032 lesson, applied: every CHECK is an explicitly named TABLE-level
-- constraint (ck_*) — column-level checks collide with table-level ones of
-- the same shape. No foreign keys by design — the tables key on the
-- feeds' stylist/protocol/location/member identifiers, content-derived
-- event ids, and reporting months (the 0036–0045 discipline; no fk_*
-- constraints exist to name).
--
-- The PR 129 lesson, applied: the distributor, leg-kind, verdict, and
-- sender vocabularies in these CHECKs are byte-identical to the TS-side
-- union types (ServiceDistributor 'loreal'/'estee_lauder',
-- ServiceBoothLeaseLegKind 'chair_rent'/'retail_commission',
-- ServiceApplicationVerdict 'paid'/'held_negative_net', and the
-- 'pos_ticket'/'hotel_folio' sender families) — verified before CI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- service_franchise_schedules: one location's franchise contract terms of
-- record — the three legs partition the gross exactly.
-- ---------------------------------------------------------------------------
create table if not exists public.service_franchise_schedules (
  id                            uuid primary key default gen_random_uuid(),
  salon_location_id             text not null,
  master_franchisor_royalty_bps bigint not null,
  technician_commission_bps     bigint not null,
  house_margin_bps              bigint not null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique (salon_location_id),
  constraint ck_service_franchise_schedules_location_present
    check (char_length(salon_location_id) > 0),
  constraint ck_service_franchise_schedules_royalty_band
    check (master_franchisor_royalty_bps >= 0 AND master_franchisor_royalty_bps <= 10000),
  constraint ck_service_franchise_schedules_commission_band
    check (technician_commission_bps >= 0 AND technician_commission_bps <= 10000),
  constraint ck_service_franchise_schedules_house_band
    check (house_margin_bps >= 0 AND house_margin_bps <= 10000),
  constraint ck_service_franchise_schedules_legs_partition_gross
    check (master_franchisor_royalty_bps + technician_commission_bps + house_margin_bps = 10000)
);

comment on table public.service_franchise_schedules is
  'One salon location''s franchise contract terms of record (migration 0046): the master franchisor royalty, technician service commission, and house location margin in basis points — the founder''s 5/45/50 example. The three legs each 0–10000 bps and summing to exactly 10000: they partition the gross service ticket. UNIQUE (salon_location_id): an upsert converges — the newest contract governs the next split. ABSENT schedule = a counted fail-closed skip (the walk never guesses a rate).';

-- ---------------------------------------------------------------------------
-- service_protocol_policies: one protocol's per-treatment micro-fee of
-- record — the creator payee and the license fee in statement micros.
-- ---------------------------------------------------------------------------
create table if not exists public.service_protocol_policies (
  id                  uuid primary key default gen_random_uuid(),
  protocol_id         text not null,
  payee_id            text not null,
  micros_per_treatment bigint not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (protocol_id),
  constraint ck_service_protocol_policies_protocol_present
    check (char_length(protocol_id) > 0),
  constraint ck_service_protocol_policies_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_service_protocol_policies_micros_positive
    check (micros_per_treatment > 0)
);

comment on table public.service_protocol_policies is
  'One branded treatment protocol''s per-treatment micro-fee policy of record (migration 0046): the protocol creator payee (the master esthetician or celebrity dermatologist) and the per-execution license fee in statement micros (1 dollar = 1e8 micros) so sub-cent pricing stays exact. UNIQUE (protocol_id): an upsert converges — the newest fee governs the next logged treatment.';

-- ---------------------------------------------------------------------------
-- service_redemption_policies: one home location's cross-location
-- redemption split terms of record — the visiting location routes the
-- residual.
-- ---------------------------------------------------------------------------
create table if not exists public.service_redemption_policies (
  id                   uuid primary key default gen_random_uuid(),
  home_location_id     text not null,
  franchisor_royalty_bps bigint not null,
  home_admin_bps       bigint not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (home_location_id),
  constraint ck_service_redemption_policies_home_present
    check (char_length(home_location_id) > 0),
  constraint ck_service_redemption_policies_royalty_band
    check (franchisor_royalty_bps >= 0 AND franchisor_royalty_bps <= 10000),
  constraint ck_service_redemption_policies_admin_band
    check (home_admin_bps >= 0 AND home_admin_bps <= 10000),
  constraint ck_service_redemption_policies_legs_at_most_gross
    check (franchisor_royalty_bps + home_admin_bps <= 10000)
);

comment on table public.service_redemption_policies is
  'One home location''s cross-location redemption split terms of record (migration 0046): the franchisor royalty and home-location administrative cut off a redemption''s service allocation fee, each 0–10000 bps summing to at most 10000 — the visiting location routes the residual, so a past-10000 sum would owe more than the fee and is refused. UNIQUE (home_location_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- service_breakage_policies: one home location's contractual breakage
-- split terms of record — the unredeemed funds allocate fully.
-- ---------------------------------------------------------------------------
create table if not exists public.service_breakage_policies (
  id                      uuid primary key default gen_random_uuid(),
  home_location_id        text not null,
  franchisor_breakage_bps bigint not null,
  franchisee_breakage_bps bigint not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (home_location_id),
  constraint ck_service_breakage_policies_home_present
    check (char_length(home_location_id) > 0),
  constraint ck_service_breakage_policies_franchisor_band
    check (franchisor_breakage_bps >= 0 AND franchisor_breakage_bps <= 10000),
  constraint ck_service_breakage_policies_franchisee_band
    check (franchisee_breakage_bps >= 0 AND franchisee_breakage_bps <= 10000),
  constraint ck_service_breakage_policies_legs_partition_breakage
    check (franchisor_breakage_bps + franchisee_breakage_bps = 10000)
);

comment on table public.service_breakage_policies is
  'One home location''s contractual breakage split terms of record (migration 0046): the franchisor and franchisee shares of unredeemed monthly subscription funds, each 0–10000 bps summing to exactly 10000 — the unredeemed funds allocate fully across the two contractual legs. UNIQUE (home_location_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- service_rebate_waterfalls: one location's rebate routing legs of record —
-- the proportional shares a volume rebate routes back through.
-- ---------------------------------------------------------------------------
create table if not exists public.service_rebate_waterfalls (
  id                uuid primary key default gen_random_uuid(),
  salon_location_id text not null,
  ledger_id         text not null,
  weight_bps        bigint not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (salon_location_id, ledger_id),
  constraint ck_service_rebate_waterfalls_location_present
    check (char_length(salon_location_id) > 0),
  constraint ck_service_rebate_waterfalls_ledger_present
    check (char_length(ledger_id) > 0),
  constraint ck_service_rebate_waterfalls_weight_band
    check (weight_bps > 0 AND weight_bps <= 10000)
);

comment on table public.service_rebate_waterfalls is
  'One salon location''s distributor rebate routing legs of record (migration 0046): the proportional shares a bulk backbar purchasing kickback routes back through to franchise location ledgers. UNIQUE (salon_location_id, ledger_id): a re-registered leg converges. Per-leg weights are 1–10000 bps; the location''s full waterfall must sum to exactly 10000 bps — validated at read across the rows (an unvalidated or absent waterfall is a counted fail-closed skip).';

-- ---------------------------------------------------------------------------
-- service_booth_lease_policies: one hybrid salon's booth-lease terms of
-- record — the studio owner payee and the retail commission rate.
-- ---------------------------------------------------------------------------
create table if not exists public.service_booth_lease_policies (
  id                   uuid primary key default gen_random_uuid(),
  salon_location_id    text not null,
  chair_rent_payee_id  text not null,
  retail_commission_bps bigint not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (salon_location_id),
  constraint ck_service_booth_lease_policies_location_present
    check (char_length(salon_location_id) > 0),
  constraint ck_service_booth_lease_policies_payee_present
    check (char_length(chair_rent_payee_id) > 0),
  constraint ck_service_booth_lease_policies_commission_band
    check (retail_commission_bps >= 0 AND retail_commission_bps <= 10000)
);

comment on table public.service_booth_lease_policies is
  'One hybrid salon''s booth-lease terms of record (migration 0046): the studio owner payee and the retail product sales commission rate — the weekly flat chair rent routes around it, isolated at application. UNIQUE (salon_location_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- service_realization_applications: the append-only Net Service Realization
-- of record — gross − backbar COGS − card cut − taxes = the pool.
-- ---------------------------------------------------------------------------
create table if not exists public.service_realization_applications (
  id                              uuid primary key default gen_random_uuid(),
  source_event_id                 text not null,
  sender                          text not null,
  stylist_id                      text not null,
  protocol_id                     text not null,
  salon_location_id               text not null,
  period                          text not null,
  currency                        text not null,
  gross_service_ticket_cents      bigint not null,
  backbar_product_cogs_cents      bigint not null,
  card_processing_engine_cut_cents bigint not null,
  service_sales_taxes_cents       bigint not null,
  net_realized_service_pool_cents bigint not null,
  verdict                         text not null,
  created_at                      timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_service_realization_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_service_realization_applications_sender_vocabulary
    check (sender IN ('pos_ticket', 'hotel_folio')),
  constraint ck_service_realization_applications_stylist_present
    check (char_length(stylist_id) > 0),
  constraint ck_service_realization_applications_protocol_present
    check (char_length(protocol_id) > 0),
  constraint ck_service_realization_applications_location_present
    check (char_length(salon_location_id) > 0),
  constraint ck_service_realization_applications_period_shape
    check (char_length(period) = 7 AND substr(period, 5, 1) = '-'),
  constraint ck_service_realization_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_service_realization_applications_gross_positive
    check (gross_service_ticket_cents > 0),
  constraint ck_service_realization_applications_backbar_non_negative
    check (backbar_product_cogs_cents >= 0),
  constraint ck_service_realization_applications_card_cut_non_negative
    check (card_processing_engine_cut_cents >= 0),
  constraint ck_service_realization_applications_taxes_non_negative
    check (service_sales_taxes_cents >= 0),
  constraint ck_service_realization_applications_net_identity
    check (net_realized_service_pool_cents
           = gross_service_ticket_cents - backbar_product_cogs_cents
             - card_processing_engine_cut_cents - service_sales_taxes_cents),
  constraint ck_service_realization_applications_verdict_vocabulary
    check (verdict IN ('paid', 'held_negative_net')),
  constraint ck_service_realization_applications_paid_pool_non_negative
    check (verdict = 'held_negative_net' OR net_realized_service_pool_cents >= 0)
);

comment on table public.service_realization_applications is
  'The append-only Net Service Realization of record per service ticket event (migration 0046), keyed on the stylist, protocol, and salon location columns: gross service ticket − backbar product COGS − credit card processing engine cut − local service and sales taxes = the Net Realized Service Pool, the identity pinned in a CHECK. A negative pool is never dropped: verdict ''held_negative_net'' pauses it visible and a ''paid'' row is CHECK-pinned non-negative. UNIQUE (source_event_id) is the replay guard — a re-shipped sheet throws, never a double application.';

-- ---------------------------------------------------------------------------
-- service_franchise_split_applications: the append-only three-way gross
-- partition of record — royalty and commission floored, the house margin
-- absorbs the floor dust.
-- ---------------------------------------------------------------------------
create table if not exists public.service_franchise_split_applications (
  id                             uuid primary key default gen_random_uuid(),
  source_event_id                text not null,
  sender                         text not null,
  stylist_id                     text not null,
  protocol_id                    text not null,
  salon_location_id              text not null,
  period                         text not null,
  currency                       text not null,
  gross_service_ticket_cents     bigint not null,
  schedule_ref                   text not null,
  master_franchisor_royalty_bps  bigint not null,
  master_franchisor_royalty_cents bigint not null,
  technician_commission_bps      bigint not null,
  technician_commission_cents    bigint not null,
  house_margin_bps               bigint not null,
  house_margin_cents             bigint not null,
  created_at                     timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_service_franchise_split_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_service_franchise_split_applications_sender_vocabulary
    check (sender IN ('pos_ticket', 'hotel_folio')),
  constraint ck_service_franchise_split_applications_stylist_present
    check (char_length(stylist_id) > 0),
  constraint ck_service_franchise_split_applications_protocol_present
    check (char_length(protocol_id) > 0),
  constraint ck_service_franchise_split_applications_location_present
    check (char_length(salon_location_id) > 0),
  constraint ck_service_franchise_split_applications_period_shape
    check (char_length(period) = 7 AND substr(period, 5, 1) = '-'),
  constraint ck_service_franchise_split_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_service_franchise_split_applications_gross_non_negative
    check (gross_service_ticket_cents >= 0),
  constraint ck_service_franchise_split_applications_schedule_ref_present
    check (char_length(schedule_ref) > 0),
  constraint ck_service_franchise_split_applications_royalty_band
    check (master_franchisor_royalty_bps >= 0 AND master_franchisor_royalty_bps <= 10000),
  constraint ck_service_franchise_split_applications_commission_band
    check (technician_commission_bps >= 0 AND technician_commission_bps <= 10000),
  constraint ck_service_franchise_split_applications_house_band
    check (house_margin_bps >= 0 AND house_margin_bps <= 10000),
  constraint ck_service_franchise_split_applications_royalty_share
    check (master_franchisor_royalty_cents
           = (gross_service_ticket_cents * master_franchisor_royalty_bps) / 10000),
  constraint ck_service_franchise_split_applications_commission_share
    check (technician_commission_cents
           = (gross_service_ticket_cents * technician_commission_bps) / 10000),
  constraint ck_service_franchise_split_applications_house_residual
    check (house_margin_cents = gross_service_ticket_cents
             - master_franchisor_royalty_cents - technician_commission_cents),
  constraint ck_service_franchise_split_applications_house_non_negative
    check (house_margin_cents >= 0)
);

comment on table public.service_franchise_split_applications is
  'The append-only three-way franchise split of record per service ticket event (migration 0046): the master franchisor royalty and technician service commission are floored shares of the gross, and the house location margin absorbs the floor dust as the residual — the arithmetic pinned in CHECKs. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- service_protocol_micro_royalties: the append-only per-treatment license
-- fee of record — routed to the protocol creator per logged treatment.
-- ---------------------------------------------------------------------------
create table if not exists public.service_protocol_micro_royalties (
  id                  uuid primary key default gen_random_uuid(),
  source_event_id     text not null,
  sender              text not null,
  stylist_id          text not null,
  protocol_id         text not null,
  salon_location_id   text not null,
  period              text not null,
  currency            text not null,
  payee_id            text not null,
  micros_per_treatment bigint not null,
  royalty_micros      bigint not null,
  royalty_cents       bigint not null,
  created_at          timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_service_protocol_micro_royalties_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_service_protocol_micro_royalties_sender_vocabulary
    check (sender IN ('pos_ticket', 'hotel_folio')),
  constraint ck_service_protocol_micro_royalties_stylist_present
    check (char_length(stylist_id) > 0),
  constraint ck_service_protocol_micro_royalties_protocol_present
    check (char_length(protocol_id) > 0),
  constraint ck_service_protocol_micro_royalties_location_present
    check (char_length(salon_location_id) > 0),
  constraint ck_service_protocol_micro_royalties_period_shape
    check (char_length(period) = 7 AND substr(period, 5, 1) = '-'),
  constraint ck_service_protocol_micro_royalties_currency_present
    check (char_length(currency) > 0),
  constraint ck_service_protocol_micro_royalties_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_service_protocol_micro_royalties_micros_positive
    check (micros_per_treatment > 0),
  constraint ck_service_protocol_micro_royalties_one_treatment_per_row
    check (royalty_micros = micros_per_treatment),
  constraint ck_service_protocol_micro_royalties_cents_conversion
    check (royalty_cents = royalty_micros / 1000000)
);

comment on table public.service_protocol_micro_royalties is
  'The append-only per-treatment protocol micro-royalty of record (migration 0046) — the license fee routed to the protocol creator (the master esthetician or celebrity dermatologist) every time a franchised location logs the branded treatment. One treatment per row: royalty_micros equals the policy''s micros_per_treatment and royalty_cents is its floored cents conversion, both pinned. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- service_redemption_split_applications: the append-only cross-location
-- redemption routing of record — the visiting location routes the residual.
-- ---------------------------------------------------------------------------
create table if not exists public.service_redemption_split_applications (
  id                          uuid primary key default gen_random_uuid(),
  source_event_id             text not null,
  member_id                   text not null,
  home_location_id            text not null,
  visiting_location_id        text not null,
  period                      text not null,
  currency                    text not null,
  service_allocation_fee_cents bigint not null,
  franchisor_royalty_bps      bigint not null,
  franchisor_royalty_cents    bigint not null,
  home_admin_bps              bigint not null,
  home_admin_cents            bigint not null,
  visiting_location_cents     bigint not null,
  created_at                  timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_service_redemption_split_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_service_redemption_split_applications_member_present
    check (char_length(member_id) > 0),
  constraint ck_service_redemption_split_applications_locations_distinct
    check (home_location_id <> visiting_location_id),
  constraint ck_service_redemption_split_applications_period_shape
    check (char_length(period) = 7 AND substr(period, 5, 1) = '-'),
  constraint ck_service_redemption_split_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_service_redemption_split_applications_fee_positive
    check (service_allocation_fee_cents > 0),
  constraint ck_service_redemption_split_applications_royalty_band
    check (franchisor_royalty_bps >= 0 AND franchisor_royalty_bps <= 10000),
  constraint ck_service_redemption_split_applications_admin_band
    check (home_admin_bps >= 0 AND home_admin_bps <= 10000),
  constraint ck_service_redemption_split_applications_royalty_share
    check (franchisor_royalty_cents
           = (service_allocation_fee_cents * franchisor_royalty_bps) / 10000),
  constraint ck_service_redemption_split_applications_admin_share
    check (home_admin_cents = (service_allocation_fee_cents * home_admin_bps) / 10000),
  constraint ck_service_redemption_split_applications_visiting_residual
    check (visiting_location_cents = service_allocation_fee_cents
             - franchisor_royalty_cents - home_admin_cents),
  constraint ck_service_redemption_split_applications_visiting_non_negative
    check (visiting_location_cents >= 0)
);

comment on table public.service_redemption_split_applications is
  'The append-only cross-location redemption routing of record (migration 0046): a member enrolled at the home location redeeming a monthly service at the visiting location routes the service allocation fee''s franchisor royalty and home-location administrative cut as floored shares, and the visiting location receives the residual — the arithmetic pinned in CHECKs, home and visiting pinned distinct. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- service_breakage_allocations: the append-only unredeemed-funds split of
-- record — the franchisor share floored, the franchisee the residual.
-- ---------------------------------------------------------------------------
create table if not exists public.service_breakage_allocations (
  id                       uuid primary key default gen_random_uuid(),
  source_event_id          text not null,
  member_id                text not null,
  home_location_id         text not null,
  period                   text not null,
  currency                 text not null,
  unredeemed_amount_cents  bigint not null,
  franchisor_breakage_bps  bigint not null,
  franchisor_breakage_cents bigint not null,
  franchisee_breakage_cents bigint not null,
  created_at               timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_service_breakage_allocations_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_service_breakage_allocations_member_present
    check (char_length(member_id) > 0),
  constraint ck_service_breakage_allocations_home_present
    check (char_length(home_location_id) > 0),
  constraint ck_service_breakage_allocations_period_shape
    check (char_length(period) = 7 AND substr(period, 5, 1) = '-'),
  constraint ck_service_breakage_allocations_currency_present
    check (char_length(currency) > 0),
  constraint ck_service_breakage_allocations_unredeemed_positive
    check (unredeemed_amount_cents > 0),
  constraint ck_service_breakage_allocations_franchisor_band
    check (franchisor_breakage_bps >= 0 AND franchisor_breakage_bps <= 10000),
  constraint ck_service_breakage_allocations_franchisor_share
    check (franchisor_breakage_cents
           = (unredeemed_amount_cents * franchisor_breakage_bps) / 10000),
  constraint ck_service_breakage_allocations_franchisee_residual
    check (franchisee_breakage_cents = unredeemed_amount_cents - franchisor_breakage_cents),
  constraint ck_service_breakage_allocations_franchisee_non_negative
    check (franchisee_breakage_cents >= 0)
);

comment on table public.service_breakage_allocations is
  'The append-only membership breakage allocation of record (migration 0046): unredeemed monthly subscription funds split per the contractual franchisor (floored share) and franchisee (residual) breakage rules — the arithmetic pinned in CHECKs. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- service_rebate_applications: the append-only proportional rebate routing
-- of record — the routed total conserves the rebate exactly.
-- ---------------------------------------------------------------------------
create table if not exists public.service_rebate_applications (
  id                 uuid primary key default gen_random_uuid(),
  source_event_id    text not null,
  distributor        text not null,
  salon_location_id  text not null,
  period             text not null,
  currency           text not null,
  rebate_basis_cents bigint not null,
  volume_rebate_cents bigint not null,
  routing_legs       text not null,
  routed_total_cents bigint not null,
  created_at         timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_service_rebate_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_service_rebate_applications_distributor_vocabulary
    check (distributor IN ('loreal', 'estee_lauder')),
  constraint ck_service_rebate_applications_location_present
    check (char_length(salon_location_id) > 0),
  constraint ck_service_rebate_applications_period_shape
    check (char_length(period) = 7 AND substr(period, 5, 1) = '-'),
  constraint ck_service_rebate_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_service_rebate_applications_basis_non_negative
    check (rebate_basis_cents >= 0),
  constraint ck_service_rebate_applications_rebate_non_negative
    check (volume_rebate_cents >= 0),
  constraint ck_service_rebate_applications_legs_present
    check (char_length(routing_legs) > 0),
  constraint ck_service_rebate_applications_routing_conserves
    check (routed_total_cents = volume_rebate_cents)
);

comment on table public.service_rebate_applications is
  'The append-only distributor rebate routing of record (migration 0046) — the bulk backbar purchasing kickback (L''Oréal, Estée Lauder) passed proportionally back to the franchise location ledgers. The committed routing legs are JSON (largest-remainder exact shares) and the routed total conserves the rebate exactly, pinned. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- service_booth_lease_applications: the append-only isolated booth-lease
-- legs of record — the flat rent exact, the retail commission floored.
-- ---------------------------------------------------------------------------
create table if not exists public.service_booth_lease_applications (
  id                    uuid primary key default gen_random_uuid(),
  source_event_id       text not null,
  salon_location_id     text not null,
  period                text not null,
  currency              text not null,
  leg_kind              text not null,
  gross_cents           bigint not null,
  retail_commission_bps bigint not null,
  studio_owner_cents    bigint not null,
  created_at            timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_service_booth_lease_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_service_booth_lease_applications_location_present
    check (char_length(salon_location_id) > 0),
  constraint ck_service_booth_lease_applications_period_shape
    check (char_length(period) = 7 AND substr(period, 5, 1) = '-'),
  constraint ck_service_booth_lease_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_service_booth_lease_applications_leg_vocabulary
    check (leg_kind IN ('chair_rent', 'retail_commission')),
  constraint ck_service_booth_lease_applications_gross_non_negative
    check (gross_cents >= 0),
  constraint ck_service_booth_lease_applications_isolation
    check (
      (
        leg_kind = 'chair_rent'
        AND retail_commission_bps = 0
        AND studio_owner_cents = gross_cents
      )
      OR (
        leg_kind = 'retail_commission'
        AND retail_commission_bps >= 0
        AND retail_commission_bps <= 10000
        AND studio_owner_cents = (gross_cents * retail_commission_bps) / 10000
      )
    )
);

comment on table public.service_booth_lease_applications is
  'The append-only booth-lease split of record per event (migration 0046) — the isolated legs: the weekly flat chair rent routes exact to the studio owner with a zero commission rate (no commission math ever touches it) and the retail product sales route their floored commission (never the flat rent). The isolation is pinned in a two-branch CHECK. UNIQUE (source_event_id) is the replay guard.';

-- The RLS deny-all posture — every service table is service-lane only
-- (the 0043/0044/0045 discipline; the probes verify deny for authenticated).

alter table public.service_franchise_schedules enable row level security;
drop policy if exists service_franchise_schedules_service_role_all
  on public.service_franchise_schedules;
create policy service_franchise_schedules_service_role_all
  on public.service_franchise_schedules
  for all
  using (false)
  with check (false);

alter table public.service_protocol_policies enable row level security;
drop policy if exists service_protocol_policies_service_role_all
  on public.service_protocol_policies;
create policy service_protocol_policies_service_role_all
  on public.service_protocol_policies
  for all
  using (false)
  with check (false);

alter table public.service_redemption_policies enable row level security;
drop policy if exists service_redemption_policies_service_role_all
  on public.service_redemption_policies;
create policy service_redemption_policies_service_role_all
  on public.service_redemption_policies
  for all
  using (false)
  with check (false);

alter table public.service_breakage_policies enable row level security;
drop policy if exists service_breakage_policies_service_role_all
  on public.service_breakage_policies;
create policy service_breakage_policies_service_role_all
  on public.service_breakage_policies
  for all
  using (false)
  with check (false);

alter table public.service_rebate_waterfalls enable row level security;
drop policy if exists service_rebate_waterfalls_service_role_all
  on public.service_rebate_waterfalls;
create policy service_rebate_waterfalls_service_role_all
  on public.service_rebate_waterfalls
  for all
  using (false)
  with check (false);

alter table public.service_booth_lease_policies enable row level security;
drop policy if exists service_booth_lease_policies_service_role_all
  on public.service_booth_lease_policies;
create policy service_booth_lease_policies_service_role_all
  on public.service_booth_lease_policies
  for all
  using (false)
  with check (false);

alter table public.service_realization_applications enable row level security;
drop policy if exists service_realization_applications_service_role_all
  on public.service_realization_applications;
create policy service_realization_applications_service_role_all
  on public.service_realization_applications
  for all
  using (false)
  with check (false);

alter table public.service_franchise_split_applications enable row level security;
drop policy if exists service_franchise_split_applications_service_role_all
  on public.service_franchise_split_applications;
create policy service_franchise_split_applications_service_role_all
  on public.service_franchise_split_applications
  for all
  using (false)
  with check (false);

alter table public.service_protocol_micro_royalties enable row level security;
drop policy if exists service_protocol_micro_royalties_service_role_all
  on public.service_protocol_micro_royalties;
create policy service_protocol_micro_royalties_service_role_all
  on public.service_protocol_micro_royalties
  for all
  using (false)
  with check (false);

alter table public.service_redemption_split_applications enable row level security;
drop policy if exists service_redemption_split_applications_service_role_all
  on public.service_redemption_split_applications;
create policy service_redemption_split_applications_service_role_all
  on public.service_redemption_split_applications
  for all
  using (false)
  with check (false);

alter table public.service_breakage_allocations enable row level security;
drop policy if exists service_breakage_allocations_service_role_all
  on public.service_breakage_allocations;
create policy service_breakage_allocations_service_role_all
  on public.service_breakage_allocations
  for all
  using (false)
  with check (false);

alter table public.service_rebate_applications enable row level security;
drop policy if exists service_rebate_applications_service_role_all
  on public.service_rebate_applications;
create policy service_rebate_applications_service_role_all
  on public.service_rebate_applications
  for all
  using (false)
  with check (false);

alter table public.service_booth_lease_applications enable row level security;
drop policy if exists service_booth_lease_applications_service_role_all
  on public.service_booth_lease_applications;
create policy service_booth_lease_applications_service_role_all
  on public.service_booth_lease_applications
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.service_franchise_schedules to service_role;
grant select, insert, update, delete on public.service_protocol_policies to service_role;
grant select, insert, update, delete on public.service_redemption_policies to service_role;
grant select, insert, update, delete on public.service_breakage_policies to service_role;
grant select, insert, update, delete on public.service_rebate_waterfalls to service_role;
grant select, insert, update, delete on public.service_booth_lease_policies to service_role;
grant select, insert, update, delete on public.service_realization_applications to service_role;
grant select, insert, update, delete on public.service_franchise_split_applications to service_role;
grant select, insert, update, delete on public.service_protocol_micro_royalties to service_role;
grant select, insert, update, delete on public.service_redemption_split_applications to service_role;
grant select, insert, update, delete on public.service_breakage_allocations to service_role;
grant select, insert, update, delete on public.service_rebate_applications to service_role;
grant select, insert, update, delete on public.service_booth_lease_applications to service_role;

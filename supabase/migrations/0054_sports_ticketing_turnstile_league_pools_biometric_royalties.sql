-- =============================================================================
-- 0054 — The sports lane: ticketing, turnstile reconciliation, gate
--        realization, resale royalties, league pools, group licensing,
--        NIL profile reconciliation, and biometric micro-payouts
--        (PR 50, the founder sports directive)
--
-- Seventeen tables:
--
--   sports_student_athlete_profiles        <- upsertSportsStudentAthleteProfile /
--                                             getSportsStudentAthleteProfile[ByNilAthleteId]
--     (the student-athlete registry of record per athlete_glan: the union
--      ledger (NFLPA or NBAPA — never 'none'), the NIL lane's athlete
--      identifier, and the athlete digital wallet payee the group
--      licensing and biometric walks route to. UNIQUE per athlete_glan:
--      an upsert converges — the newest profile governs the next
--      eligibility and routing decision.)
--
--   sports_resale_royalty_policies         <- upsertSportsResaleRoyaltyPolicy /
--                                             getSportsResaleRoyaltyPolicy
--     (the perpetual resale royalty policy of record per
--      (venue_gln, league_rights_code): the founder band, 500–1000 bps
--      (5–10%), split across promoter, venue, and league rights holders.
--      The conservation CHECK pins the three shares into the full
--      10000 bps pot at the database too.)
--
--   sports_league_pool_policies            <- upsertSportsLeaguePoolPolicy /
--                                             getSportsLeaguePoolPolicy
--     (the league-wide pool waterfall policy of record per
--      league_rights_code: equal share, market-size balance, and
--      performance incentive legs in bps. The conservation CHECK pins
--      the three legs into the full pot.)
--
--   sports_league_team_registrations       <- upsertSportsLeagueTeamRegistration /
--                                             listSportsLeagueTeamRegistrations
--     (the team registrations of record per (league_rights_code,
--      team_code): the market size, payroll, cap threshold, and
--      performance incentive the pool waterfall's offsets read.
--      UNIQUE per (league_rights_code, team_code): an upsert converges.)
--
--   sports_biometric_royalty_policies      <- upsertSportsBiometricRoyaltyPolicy /
--                                             getSportsBiometricRoyaltyPolicy
--     (the biometric micro-royalty policy of record per
--      (league_rights_code, licensee_class): the money micros per
--      quantity micro and the athlete share of the payout pot.
--      UNIQUE per scope: an upsert converges.)
--
--   sports_ticket_sale_posts               <- insertSportsTicketSalePost /
--                                             getSportsTicketSalePost /
--                                             aggregateSportsTicketSalePosts
--     (the primary ticketers' append-only receipt truth (Ticketmaster,
--      AXS, SeatGeek): the founder's five identity columns
--      (nil_contract_id, athlete_glan, venue_gln, league_rights_code,
--      turnstile_scan_hash) plus period and currency, the five
--      settlement legs, and the ticket count. UNIQUE per
--      source_event_id: the replay guard. Indexed for the venue-scope
--      reconciliation aggregate and the founder-tuple realization
--      recompute.)
--
--   sports_resale_sale_posts               <- insertSportsResaleSalePost /
--                                             getSportsResaleSalePost /
--                                             aggregateSportsResaleSalePosts
--     (the secondary marketplaces' append-only resale truth (StubHub,
--      Vivid Seats). UNIQUE per source_event_id: the replay guard.)
--
--   sports_turnstile_scan_posts            <- insertSportsTurnstileScanPost /
--                                             getSportsTurnstileScanPost /
--                                             aggregateSportsTurnstileScanPosts
--     (the venue turnstile telemetry's append-only scan truth.
--      UNIQUE per source_event_id: the replay guard.)
--
--   sports_biometric_tracking_posts        <- insertSportsBiometricTrackingPost /
--                                             getSportsBiometricTrackingPost /
--                                             aggregateSportsBiometricTrackingPosts
--     (the wearable and optical tracking feeds' append-only licensed-
--      quantity truth. UNIQUE per source_event_id: the replay guard.)
--
--   sports_broadcasting_contracts          <- insertSportsBroadcastingContract /
--                                             getSportsBroadcastingContract /
--                                             listSportsBroadcastingContracts
--     (the league media rights and merchandise pool contracts of
--      record: national and international broadcasting, the collective
--      merchandise pool, and the three group licensing streams, each
--      carrying its gross, its royalty pot, its union ledger, and its
--      athlete roster. UNIQUE per contract_ref: the replay guard — a
--      re-shipped contract is a conflict, never a second row.)
--
--   sports_gate_reconciliations            <- upsertSportsGateReconciliation /
--                                             getSportsGateReconciliation
--     (the turnstile-to-receipt reconciliation of record per
--      (venue_gln, period, currency): the scan-side and receipt-side
--      sums, the signed variance delta, and the verdict that gates
--      realization. UNIQUE per (venue_gln, period, currency): the
--      recompute replaces the position in place. The conservation
--      CHECK pins the delta as the scan side minus the receipt side.)
--
--   sports_net_venue_realizations          <- upsertSportsNetVenueRealization /
--                                             getSportsNetVenueRealization
--     (the Net Venue Realization of record per the founder's five
--      identity columns plus period and currency: gross ticket revenue
--      − facility surcharges − municipal taxes − insurance reserves −
--      payment processor fee cuts = the Net Gate Pool. UNIQUE per the
--      founder tuple: the recompute replaces the sums in place. The
--      conservation CHECK pins the arithmetic; the verdict CHECK pins
--      held negative nets — a negative pool holds, never posts.)
--
--   sports_resale_royalty_applications     <- insertSportsResaleRoyaltyApplication /
--                                             getSportsResaleRoyaltyApplication
--     (the append-only resale royalty routing truth: the 5–10% pot and
--      its three legs. UNIQUE per source_event_id: the replay guard.
--      The conservation CHECK pins the three legs into the pot.)
--
--   sports_league_pool_distributions       <- upsertSportsLeaguePoolDistribution /
--                                             getSportsLeaguePoolDistribution
--     (the league pool waterfall of record per (league_rights_code,
--      period, currency): the pool, the policy legs in bps, the per-
--      team legs of record, the distributed total, and the dust.
--      UNIQUE per scope: the recompute replaces the position in place.
--      The conservation CHECKs pin the waterfall: distributed + dust
--      = pool, and the three policy legs conserve the full pot.)
--
--   sports_group_licensing_applications    <- insertSportsGroupLicensingApplication /
--                                             getSportsGroupLicensingApplication
--     (the append-only group licensing routing truth: the union leg
--      and the equal athlete wallet split. UNIQUE per source_event_id:
--      the replay guard. The conservation CHECK pins the union leg
--      plus the athlete pool into the royalty pot.)
--
--   sports_nil_deal_reconciliations        <- upsertSportsNilDealReconciliation /
--                                             getSportsNilDealReconciliation
--     (the NIL deal waterfall reconciliation of record per
--      (nil_contract_id, athlete_glan, period): the endorsement,
--      booster collective, and fan-club legs against the student-
--      athlete profile, with the unmatched/ineligible verdicts the
--      fail-closed resolution flags. UNIQUE per scope: the recompute
--      replaces the position in place. The conservation CHECK pins
--      the gross as the sum of the three legs.)
--
--   sports_biometric_micro_payout_applications
--                                           <- insertSportsBiometricMicroPayoutApplication /
--                                              getSportsBiometricMicroPayoutApplication
--     (the append-only biometric micro-payout truth: the per-license
--      pot and its athlete and league data legs. UNIQUE per
--      source_event_id: the replay guard. The conservation CHECK pins
--      the two legs into the pot.)
--
-- SQL CHECK vocabularies are byte-identical to the TypeScript engine's
-- union constants (src/modules/sports/records.ts) and to the SQLite
-- mirror's CHECKs (src/lib/server/sqliteStore.ts) — verified
-- byte-identical before CI dispatch (the PR 133/134/137/138
-- discipline).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- sports_student_athlete_profiles: the student-athlete registry of
-- record — the union ledger, the NIL identifier, the digital wallet.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_student_athlete_profiles (
  id             uuid primary key default gen_random_uuid(),
  athlete_glan   text not null,
  full_name      text not null,
  school_id      text not null,
  union_code     text not null,
  nil_athlete_id text not null,
  wallet_payee_id text not null,
  eligible       boolean not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (athlete_glan),
  constraint ck_sports_student_athlete_profiles_athlete_glan_present
    check (char_length(athlete_glan) > 0),
  constraint ck_sports_student_athlete_profiles_full_name_present
    check (char_length(full_name) > 0),
  constraint ck_sports_student_athlete_profiles_school_present
    check (char_length(school_id) > 0),
  constraint ck_sports_student_athlete_profiles_union_vocabulary
    check (union_code IN ('NFLPA', 'NBAPA')),
  constraint ck_sports_student_athlete_profiles_nil_athlete_present
    check (char_length(nil_athlete_id) > 0),
  constraint ck_sports_student_athlete_profiles_wallet_present
    check (char_length(wallet_payee_id) > 0)
);
create index if not exists idx_sports_profiles_nil_athlete
  on public.sports_student_athlete_profiles (nil_athlete_id);

comment on table public.sports_student_athlete_profiles is
  'The student-athlete registry of record per athlete_glan (migration 0054) — the union ledger (NFLPA or NBAPA, never ''none''), the NIL lane''s athlete identifier, and the athlete digital wallet payee the group licensing and biometric walks route to. UNIQUE (athlete_glan): an upsert converges — the newest profile governs the next eligibility and routing decision. An ineligible athlete''s payouts fail closed.';

-- ---------------------------------------------------------------------------
-- sports_resale_royalty_policies: the perpetual resale royalty policy
-- of record — the founder band, 500–1000 bps (5–10%), three-way split.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_resale_royalty_policies (
  id                 uuid primary key default gen_random_uuid(),
  venue_gln          text not null,
  league_rights_code text not null,
  promoter_payee_id   text not null,
  promoter_payee_name text not null,
  venue_payee_id      text not null,
  venue_payee_name    text not null,
  league_payee_id     text not null,
  league_payee_name   text not null,
  resale_royalty_bps  bigint not null,
  promoter_share_bps  bigint not null,
  venue_share_bps     bigint not null,
  league_share_bps    bigint not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (venue_gln, league_rights_code),
  constraint ck_sports_resale_royalty_policies_venue_present
    check (char_length(venue_gln) > 0),
  constraint ck_sports_resale_royalty_policies_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_resale_royalty_policies_promoter_id_present
    check (char_length(promoter_payee_id) > 0),
  constraint ck_sports_resale_royalty_policies_promoter_name_present
    check (char_length(promoter_payee_name) > 0),
  constraint ck_sports_resale_royalty_policies_venue_id_present
    check (char_length(venue_payee_id) > 0),
  constraint ck_sports_resale_royalty_policies_venue_name_present
    check (char_length(venue_payee_name) > 0),
  constraint ck_sports_resale_royalty_policies_league_id_present
    check (char_length(league_payee_id) > 0),
  constraint ck_sports_resale_royalty_policies_league_name_present
    check (char_length(league_payee_name) > 0),
  constraint ck_sports_resale_royalty_policies_rate_in_founder_band
    check (resale_royalty_bps >= 500 AND resale_royalty_bps <= 1000),
  constraint ck_sports_resale_royalty_policies_promoter_share_non_negative
    check (promoter_share_bps >= 0),
  constraint ck_sports_resale_royalty_policies_venue_share_non_negative
    check (venue_share_bps >= 0),
  constraint ck_sports_resale_royalty_policies_league_share_non_negative
    check (league_share_bps >= 0),
  constraint ck_sports_resale_royalty_policies_shares_conserve
    check (promoter_share_bps + venue_share_bps + league_share_bps = 10000)
);

comment on table public.sports_resale_royalty_policies is
  'The perpetual resale royalty policy of record per (venue_gln, league_rights_code) (migration 0054) — the founder-banded 500–1000 bps (5–10%) cut of every secondary-market sale, split across promoter, venue, and league rights holders. UNIQUE (venue_gln, league_rights_code): an upsert converges. The CHECK pins the band and the three-way conservation at the database too.';

-- ---------------------------------------------------------------------------
-- sports_league_pool_policies: the league-wide pool waterfall policy of
-- record — equal share, market-size balance, performance incentive.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_league_pool_policies (
  id                      uuid primary key default gen_random_uuid(),
  league_rights_code      text not null,
  equal_share_bps         bigint not null,
  market_balance_bps      bigint not null,
  performance_incentive_bps bigint not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (league_rights_code),
  constraint ck_sports_league_pool_policies_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_league_pool_policies_equal_share_non_negative
    check (equal_share_bps >= 0),
  constraint ck_sports_league_pool_policies_market_balance_non_negative
    check (market_balance_bps >= 0),
  constraint ck_sports_league_pool_policies_incentive_non_negative
    check (performance_incentive_bps >= 0),
  constraint ck_sports_league_pool_policies_shares_conserve
    check (equal_share_bps + market_balance_bps + performance_incentive_bps = 10000)
);

comment on table public.sports_league_pool_policies is
  'The league-wide pool waterfall policy of record per league_rights_code (migration 0054) — the equal share, market-size balance, and performance incentive legs in bps that the pool distribution across team owners reads. UNIQUE (league_rights_code): an upsert converges. The CHECK pins the three legs into the full 10000 bps pot.';

-- ---------------------------------------------------------------------------
-- sports_league_team_registrations: the team registrations of record —
-- market size, payroll, cap threshold, performance incentive.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_league_team_registrations (
  id                      uuid primary key default gen_random_uuid(),
  league_rights_code      text not null,
  team_code               text not null,
  owner_payee_id          text not null,
  owner_payee_name        text not null,
  market_size_micros      bigint not null,
  payroll_micros          bigint not null,
  cap_threshold_micros    bigint not null,
  performance_incentive_bps bigint not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (league_rights_code, team_code),
  constraint ck_sports_league_team_registrations_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_league_team_registrations_team_present
    check (char_length(team_code) > 0),
  constraint ck_sports_league_team_registrations_owner_id_present
    check (char_length(owner_payee_id) > 0),
  constraint ck_sports_league_team_registrations_owner_name_present
    check (char_length(owner_payee_name) > 0),
  constraint ck_sports_league_team_registrations_market_size_positive
    check (market_size_micros >= 1),
  constraint ck_sports_league_team_registrations_payroll_non_negative
    check (payroll_micros >= 0),
  constraint ck_sports_league_team_registrations_cap_positive
    check (cap_threshold_micros >= 1),
  constraint ck_sports_league_team_registrations_incentive_in_band
    check (performance_incentive_bps >= 0 AND performance_incentive_bps <= 1000)
);

comment on table public.sports_league_team_registrations is
  'The team registrations of record per (league_rights_code, team_code) (migration 0054) — the market size, payroll, cap threshold, and performance incentive the league pool waterfall''s offsets read. UNIQUE (league_rights_code, team_code): an upsert converges. The CHECK pins the market size and cap positivity and the 0–1000 bps incentive band at the database too.';

-- ---------------------------------------------------------------------------
-- sports_biometric_royalty_policies: the biometric micro-royalty
-- policy of record — micros per unit and the athlete share.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_biometric_royalty_policies (
  id                     uuid primary key default gen_random_uuid(),
  league_rights_code     text not null,
  licensee_class         text not null,
  league_data_payee_id   text not null,
  league_data_payee_name text not null,
  micros_per_unit        bigint not null,
  athlete_share_bps      bigint not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (league_rights_code, licensee_class),
  constraint ck_sports_biometric_royalty_policies_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_biometric_royalty_policies_licensee_vocabulary
    check (licensee_class IN ('sportsbook', 'media_network', 'health_tech')),
  constraint ck_sports_biometric_royalty_policies_league_data_id_present
    check (char_length(league_data_payee_id) > 0),
  constraint ck_sports_biometric_royalty_policies_league_data_name_present
    check (char_length(league_data_payee_name) > 0),
  constraint ck_sports_biometric_royalty_policies_rate_positive
    check (micros_per_unit >= 1),
  constraint ck_sports_biometric_royalty_policies_athlete_share_in_band
    check (athlete_share_bps >= 0 AND athlete_share_bps <= 10000)
);

comment on table public.sports_biometric_royalty_policies is
  'The biometric micro-royalty policy of record per (league_rights_code, licensee_class) (migration 0054) — the money micros per quantity micro and the athlete share of the payout pot for wearable and optical tracking licensed to sportsbooks, media networks, and health tech platforms. UNIQUE (league_rights_code, licensee_class): an upsert converges.';

-- ---------------------------------------------------------------------------
-- sports_ticket_sale_posts: the primary ticketers' append-only receipt
-- truth — the founder's five identity columns and five legs.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_ticket_sale_posts (
  id                          uuid primary key default gen_random_uuid(),
  source_event_id             text not null,
  nil_contract_id             text not null,
  athlete_glan                text not null,
  venue_gln                   text not null,
  league_rights_code          text not null,
  turnstile_scan_hash         text not null,
  period                      text not null,
  currency                    text not null,
  gross_ticket_revenue_cents  bigint not null,
  facility_surcharges_cents   bigint not null,
  municipal_taxes_cents       bigint not null,
  insurance_reserves_cents    bigint not null,
  processor_fee_cuts_cents    bigint not null,
  ticket_count                bigint not null,
  created_at                  timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_sports_ticket_sale_posts_contract_present
    check (char_length(nil_contract_id) > 0),
  constraint ck_sports_ticket_sale_posts_athlete_present
    check (char_length(athlete_glan) > 0),
  constraint ck_sports_ticket_sale_posts_venue_present
    check (char_length(venue_gln) > 0),
  constraint ck_sports_ticket_sale_posts_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_ticket_sale_posts_scan_hash_present
    check (char_length(turnstile_scan_hash) > 0),
  constraint ck_sports_ticket_sale_posts_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_sports_ticket_sale_posts_gross_non_negative
    check (gross_ticket_revenue_cents >= 0),
  constraint ck_sports_ticket_sale_posts_surcharges_non_negative
    check (facility_surcharges_cents >= 0),
  constraint ck_sports_ticket_sale_posts_taxes_non_negative
    check (municipal_taxes_cents >= 0),
  constraint ck_sports_ticket_sale_posts_insurance_non_negative
    check (insurance_reserves_cents >= 0),
  constraint ck_sports_ticket_sale_posts_processor_non_negative
    check (processor_fee_cuts_cents >= 0),
  constraint ck_sports_ticket_sale_posts_ticket_count_positive
    check (ticket_count >= 1)
);
create index if not exists idx_sports_ticket_sale_posts_recon
  on public.sports_ticket_sale_posts (venue_gln, period, currency);
create index if not exists idx_sports_ticket_sale_posts_realization
  on public.sports_ticket_sale_posts (nil_contract_id, athlete_glan, venue_gln,
    league_rights_code, turnstile_scan_hash, period, currency);

comment on table public.sports_ticket_sale_posts is
  'The primary ticketers'' append-only receipt truth (migration 0054) — Ticketmaster, AXS, and SeatGeek rows: the founder''s five identity columns (nil_contract_id, athlete_glan, venue_gln, league_rights_code, turnstile_scan_hash), period and currency, the five settlement legs, and the ticket count. UNIQUE (source_event_id): the replay guard. Negative money and refund rows are rejected at the parser, and the CHECKs pin non-negativity at the database too.';

-- ---------------------------------------------------------------------------
-- sports_resale_sale_posts: the secondary marketplaces' append-only
-- resale truth — StubHub and Vivid Seats rows.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_resale_sale_posts (
  id                uuid primary key default gen_random_uuid(),
  source_event_id   text not null,
  venue_gln         text not null,
  league_rights_code text not null,
  resale_gross_cents bigint not null,
  period            text not null,
  currency          text not null,
  created_at        timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_sports_resale_sale_posts_venue_present
    check (char_length(venue_gln) > 0),
  constraint ck_sports_resale_sale_posts_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_resale_sale_posts_gross_non_negative
    check (resale_gross_cents >= 0),
  constraint ck_sports_resale_sale_posts_period_shape
    check (period ~ '^\d{4}-\d{2}$')
);
create index if not exists idx_sports_resale_sale_posts_scope
  on public.sports_resale_sale_posts (venue_gln, period, currency);

comment on table public.sports_resale_sale_posts is
  'The secondary marketplaces'' append-only resale truth (migration 0054) — StubHub and Vivid Seats rows feeding the perpetual 5–10% resale royalty routing. UNIQUE (source_event_id): the replay guard.';

-- ---------------------------------------------------------------------------
-- sports_turnstile_scan_posts: the venue turnstile telemetry's
-- append-only scan truth.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_turnstile_scan_posts (
  id                  uuid primary key default gen_random_uuid(),
  source_event_id     text not null,
  venue_gln           text not null,
  turnstile_scan_hash text not null,
  scan_count          bigint not null,
  period              text not null,
  currency            text not null,
  created_at          timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_sports_turnstile_scan_posts_venue_present
    check (char_length(venue_gln) > 0),
  constraint ck_sports_turnstile_scan_posts_scan_hash_present
    check (char_length(turnstile_scan_hash) > 0),
  constraint ck_sports_turnstile_scan_posts_scan_count_positive
    check (scan_count >= 1),
  constraint ck_sports_turnstile_scan_posts_period_shape
    check (period ~ '^\d{4}-\d{2}$')
);
create index if not exists idx_sports_turnstile_scan_posts_scope
  on public.sports_turnstile_scan_posts (venue_gln, period, currency);

comment on table public.sports_turnstile_scan_posts is
  'The venue turnstile telemetry''s append-only scan truth (migration 0054) — the scan counts the reconciliation aggregates against gross ticket receipts before gate realization. UNIQUE (source_event_id): the replay guard.';

-- ---------------------------------------------------------------------------
-- sports_biometric_tracking_posts: the wearable and optical tracking
-- feeds' append-only licensed-quantity truth.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_biometric_tracking_posts (
  id                        uuid primary key default gen_random_uuid(),
  source_event_id           text not null,
  athlete_glan              text not null,
  league_rights_code        text not null,
  tracking_modality         text not null,
  licensee_class            text not null,
  licensed_quantity_micros  bigint not null,
  period                    text not null,
  currency                  text not null,
  created_at                timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_sports_biometric_tracking_posts_athlete_present
    check (char_length(athlete_glan) > 0),
  constraint ck_sports_biometric_tracking_posts_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_biometric_tracking_posts_modality_vocabulary
    check (tracking_modality IN ('wearable', 'optical')),
  constraint ck_sports_biometric_tracking_posts_licensee_vocabulary
    check (licensee_class IN ('sportsbook', 'media_network', 'health_tech')),
  constraint ck_sports_biometric_tracking_posts_quantity_positive
    check (licensed_quantity_micros >= 1),
  constraint ck_sports_biometric_tracking_posts_period_shape
    check (period ~ '^\d{4}-\d{2}$')
);

comment on table public.sports_biometric_tracking_posts is
  'The wearable and optical tracking feeds'' append-only licensed-quantity truth (migration 0054) — per-license micro-payout inputs for athletes or league data rights holders. UNIQUE (source_event_id): the replay guard.';

-- ---------------------------------------------------------------------------
-- sports_broadcasting_contracts: the league media rights and
-- merchandise pool contracts of record.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_broadcasting_contracts (
  id                  uuid primary key default gen_random_uuid(),
  contract_ref        text not null,
  league_rights_code  text not null,
  contract_class      text not null,
  contract_gross_cents bigint not null,
  royalty_pool_cents  bigint not null,
  union_code          text not null,
  union_share_bps     bigint not null,
  athlete_roster_json text not null,
  period              text not null,
  currency            text not null,
  created_at          timestamptz not null default now(),
  unique (contract_ref),
  constraint ck_sports_broadcasting_contracts_ref_present
    check (char_length(contract_ref) > 0),
  constraint ck_sports_broadcasting_contracts_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_broadcasting_contracts_class_vocabulary
    check (contract_class IN (
      'broadcasting_national', 'broadcasting_international', 'merchandise_pool',
      'group_licensing_video_games', 'group_licensing_trading_cards',
      'group_licensing_apparel')),
  constraint ck_sports_broadcasting_contracts_gross_non_negative
    check (contract_gross_cents >= 0),
  constraint ck_sports_broadcasting_contracts_pool_non_negative
    check (royalty_pool_cents >= 0),
  constraint ck_sports_broadcasting_contracts_union_vocabulary
    check (union_code IN ('NFLPA', 'NBAPA', 'none')),
  constraint ck_sports_broadcasting_contracts_union_share_in_band
    check (union_share_bps >= 0 AND union_share_bps <= 10000),
  constraint ck_sports_broadcasting_contracts_roster_present
    check (char_length(athlete_roster_json) > 0),
  constraint ck_sports_broadcasting_contracts_period_shape
    check (period ~ '^\d{4}-\d{2}$')
);
create index if not exists idx_sports_broadcasting_contracts_pool
  on public.sports_broadcasting_contracts (league_rights_code, period, currency);

comment on table public.sports_broadcasting_contracts is
  'The league media rights and merchandise pool contracts of record (migration 0054) — national and international broadcasting, the collective merchandise pool, and the video game, trading card, and apparel group licensing streams, each carrying its gross, its royalty pot, its union ledger (NFLPA, NBAPA, or ''none'' for pool classes), and its athlete roster. UNIQUE (contract_ref): the replay guard — a re-shipped contract is a conflict, never a second row.';

-- ---------------------------------------------------------------------------
-- sports_gate_reconciliations: the turnstile-to-receipt reconciliation
-- of record — the gate that realization reads.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_gate_reconciliations (
  id                         uuid primary key default gen_random_uuid(),
  source_event_id            text not null,
  venue_gln                  text not null,
  period                     text not null,
  currency                   text not null,
  ticket_count_sum           bigint not null,
  scan_count_sum             bigint not null,
  variance_scan_delta        bigint not null,
  gross_ticket_revenue_cents bigint not null,
  verdict                    text not null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (source_event_id),
  unique (venue_gln, period, currency),
  constraint ck_sports_gate_reconciliations_venue_present
    check (char_length(venue_gln) > 0),
  constraint ck_sports_gate_reconciliations_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_sports_gate_reconciliations_ticket_sum_non_negative
    check (ticket_count_sum >= 0),
  constraint ck_sports_gate_reconciliations_scan_sum_non_negative
    check (scan_count_sum >= 0),
  constraint ck_sports_gate_reconciliations_gross_non_negative
    check (gross_ticket_revenue_cents >= 0),
  constraint ck_sports_gate_reconciliations_verdict_vocabulary
    check (verdict IN ('reconciled', 'variance_flagged', 'unreconciled')),
  constraint ck_sports_gate_reconciliations_delta_conserves
    check (variance_scan_delta = scan_count_sum - ticket_count_sum)
);

comment on table public.sports_gate_reconciliations is
  'The turnstile-to-receipt reconciliation of record per (venue_gln, period, currency) (migration 0054) — the scan-side and receipt-side sums, the signed variance delta, and the verdict (reconciled, variance_flagged, unreconciled) that gates realization. UNIQUE (venue_gln, period, currency): the recompute replaces the position in place. The CHECK pins the delta as the scan side minus the receipt side.';

-- ---------------------------------------------------------------------------
-- sports_net_venue_realizations: the Net Venue Realization of record —
-- the founder's five identity columns and the Net Gate Pool.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_net_venue_realizations (
  id                            uuid primary key default gen_random_uuid(),
  source_event_id               text not null,
  nil_contract_id               text not null,
  athlete_glan                  text not null,
  venue_gln                     text not null,
  league_rights_code            text not null,
  turnstile_scan_hash           text not null,
  period                        text not null,
  currency                      text not null,
  gross_ticket_revenue_cents    bigint not null,
  facility_surcharges_cents     bigint not null,
  municipal_taxes_cents         bigint not null,
  insurance_reserves_cents      bigint not null,
  processor_fee_cuts_cents      bigint not null,
  net_gate_pool_cents           bigint not null,
  gate_reconciliation_event_id  text not null,
  gate_reconciliation_verdict   text not null,
  verdict                       text not null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique (source_event_id),
  unique (nil_contract_id, athlete_glan, venue_gln, league_rights_code,
    turnstile_scan_hash, period, currency),
  constraint ck_sports_net_venue_realizations_contract_present
    check (char_length(nil_contract_id) > 0),
  constraint ck_sports_net_venue_realizations_athlete_present
    check (char_length(athlete_glan) > 0),
  constraint ck_sports_net_venue_realizations_venue_present
    check (char_length(venue_gln) > 0),
  constraint ck_sports_net_venue_realizations_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_net_venue_realizations_scan_hash_present
    check (char_length(turnstile_scan_hash) > 0),
  constraint ck_sports_net_venue_realizations_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_sports_net_venue_realizations_gross_non_negative
    check (gross_ticket_revenue_cents >= 0),
  constraint ck_sports_net_venue_realizations_surcharges_non_negative
    check (facility_surcharges_cents >= 0),
  constraint ck_sports_net_venue_realizations_taxes_non_negative
    check (municipal_taxes_cents >= 0),
  constraint ck_sports_net_venue_realizations_insurance_non_negative
    check (insurance_reserves_cents >= 0),
  constraint ck_sports_net_venue_realizations_processor_non_negative
    check (processor_fee_cuts_cents >= 0),
  constraint ck_sports_net_venue_realizations_recon_event_present
    check (char_length(gate_reconciliation_event_id) > 0),
  constraint ck_sports_net_venue_realizations_recon_verdict_vocabulary
    check (gate_reconciliation_verdict IN ('reconciled', 'variance_flagged', 'unreconciled')),
  constraint ck_sports_net_venue_realizations_verdict_vocabulary
    check (verdict IN ('posted', 'held_negative_net')),
  constraint ck_sports_net_venue_realizations_net_gate_pool_conserves
    check (
      net_gate_pool_cents
      = gross_ticket_revenue_cents
        - facility_surcharges_cents - municipal_taxes_cents
        - insurance_reserves_cents - processor_fee_cuts_cents
    ),
  constraint ck_sports_net_venue_realizations_verdict_matches_net
    check (
      (net_gate_pool_cents < 0 AND verdict = 'held_negative_net')
      OR (net_gate_pool_cents >= 0 AND verdict = 'posted')
    )
);

comment on table public.sports_net_venue_realizations is
  'The Net Venue Realization of record per the founder''s five identity columns plus period and currency (migration 0054) — gross ticket revenue − facility surcharges − municipal taxes − insurance reserves − payment processor fee cuts = the Net Gate Pool, the pool the resale, league, licensing, NIL, and biometric walks price from. UNIQUE (founder tuple, period, currency): the recompute replaces the sums in place. The CHECKs pin the arithmetic and the held-negative-net verdict at the database too.';

-- ---------------------------------------------------------------------------
-- sports_resale_royalty_applications: the append-only resale royalty
-- routing truth — the pot and its three legs.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_resale_royalty_applications (
  id                  uuid primary key default gen_random_uuid(),
  source_event_id     text not null,
  resale_sale_event_id text not null,
  venue_gln           text not null,
  league_rights_code  text not null,
  resale_gross_cents  bigint not null,
  resale_royalty_bps  bigint not null,
  promoter_share_bps  bigint not null,
  venue_share_bps     bigint not null,
  league_share_bps    bigint not null,
  royalty_pot_cents   bigint not null,
  promoter_leg_cents  bigint not null,
  venue_leg_cents     bigint not null,
  league_leg_cents    bigint not null,
  created_at          timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_sports_resale_royalty_applications_resale_event_present
    check (char_length(resale_sale_event_id) > 0),
  constraint ck_sports_resale_royalty_applications_venue_present
    check (char_length(venue_gln) > 0),
  constraint ck_sports_resale_royalty_applications_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_resale_royalty_applications_gross_non_negative
    check (resale_gross_cents >= 0),
  constraint ck_sports_resale_royalty_applications_rate_in_founder_band
    check (resale_royalty_bps >= 500 AND resale_royalty_bps <= 1000),
  constraint ck_sports_resale_royalty_applications_promoter_share_non_negative
    check (promoter_share_bps >= 0),
  constraint ck_sports_resale_royalty_applications_venue_share_non_negative
    check (venue_share_bps >= 0),
  constraint ck_sports_resale_royalty_applications_league_share_non_negative
    check (league_share_bps >= 0),
  constraint ck_sports_resale_royalty_applications_pot_non_negative
    check (royalty_pot_cents >= 0),
  constraint ck_sports_resale_royalty_applications_promoter_leg_non_negative
    check (promoter_leg_cents >= 0),
  constraint ck_sports_resale_royalty_applications_venue_leg_non_negative
    check (venue_leg_cents >= 0),
  constraint ck_sports_resale_royalty_applications_league_leg_non_negative
    check (league_leg_cents >= 0),
  constraint ck_sports_resale_royalty_applications_legs_conserve
    check (promoter_leg_cents + venue_leg_cents + league_leg_cents = royalty_pot_cents)
);

comment on table public.sports_resale_royalty_applications is
  'The append-only resale royalty routing truth (migration 0054) — one row per secondary sale''s perpetual 5–10% cut: the pot and its promoter, venue, and league legs. UNIQUE (source_event_id): the replay guard. The CHECK pins the three legs into the pot.';

-- ---------------------------------------------------------------------------
-- sports_league_pool_distributions: the league pool waterfall of
-- record — the pool, the policy legs, the team legs, the dust.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_league_pool_distributions (
  id                        uuid primary key default gen_random_uuid(),
  source_event_id           text not null,
  league_rights_code        text not null,
  period                    text not null,
  currency                  text not null,
  pool_cents                bigint not null,
  equal_share_bps           bigint not null,
  market_balance_bps        bigint not null,
  performance_incentive_bps bigint not null,
  legs_json                 text not null,
  distributed_cents         bigint not null,
  dust_cents                bigint not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (source_event_id),
  unique (league_rights_code, period, currency),
  constraint ck_sports_league_pool_distributions_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_league_pool_distributions_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_sports_league_pool_distributions_pool_non_negative
    check (pool_cents >= 0),
  constraint ck_sports_league_pool_distributions_equal_share_non_negative
    check (equal_share_bps >= 0),
  constraint ck_sports_league_pool_distributions_market_balance_non_negative
    check (market_balance_bps >= 0),
  constraint ck_sports_league_pool_distributions_incentive_non_negative
    check (performance_incentive_bps >= 0),
  constraint ck_sports_league_pool_distributions_legs_present
    check (char_length(legs_json) > 0),
  constraint ck_sports_league_pool_distributions_distributed_non_negative
    check (distributed_cents >= 0),
  constraint ck_sports_league_pool_distributions_dust_non_negative
    check (dust_cents >= 0),
  constraint ck_sports_league_pool_distributions_waterfall_conserves
    check (distributed_cents + dust_cents = pool_cents),
  constraint ck_sports_league_pool_distributions_policy_conserves
    check (equal_share_bps + market_balance_bps + performance_incentive_bps = 10000)
);

comment on table public.sports_league_pool_distributions is
  'The league pool waterfall of record per (league_rights_code, period, currency) (migration 0054) — the pool, the equal/market-balance/incentive policy legs, the per-team legs of record (JSON), the distributed total, and the dust. UNIQUE (league_rights_code, period, currency): the recompute replaces the position in place. The CHECKs pin the waterfall: distributed + dust = pool, and the policy legs conserve the full pot.';

-- ---------------------------------------------------------------------------
-- sports_group_licensing_applications: the append-only group licensing
-- routing truth — the union leg and the athlete wallet split.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_group_licensing_applications (
  id                  uuid primary key default gen_random_uuid(),
  source_event_id     text not null,
  contract_ref        text not null,
  league_rights_code  text not null,
  union_code          text not null,
  union_payee_id      text not null,
  union_share_bps     bigint not null,
  royalty_pool_cents  bigint not null,
  union_leg_cents     bigint not null,
  athlete_pool_cents  bigint not null,
  athlete_wallets_json text not null,
  wallet_count        bigint not null,
  created_at          timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_sports_group_licensing_applications_contract_present
    check (char_length(contract_ref) > 0),
  constraint ck_sports_group_licensing_applications_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_group_licensing_applications_union_vocabulary
    check (union_code IN ('NFLPA', 'NBAPA')),
  constraint ck_sports_group_licensing_applications_union_payee_present
    check (char_length(union_payee_id) > 0),
  constraint ck_sports_group_licensing_applications_union_share_in_band
    check (union_share_bps >= 0 AND union_share_bps <= 10000),
  constraint ck_sports_group_licensing_applications_pool_non_negative
    check (royalty_pool_cents >= 0),
  constraint ck_sports_group_licensing_applications_union_leg_non_negative
    check (union_leg_cents >= 0),
  constraint ck_sports_group_licensing_applications_athlete_pool_non_negative
    check (athlete_pool_cents >= 0),
  constraint ck_sports_group_licensing_applications_wallets_present
    check (char_length(athlete_wallets_json) > 0),
  constraint ck_sports_group_licensing_applications_wallet_count_positive
    check (wallet_count >= 1),
  constraint ck_sports_group_licensing_applications_split_conserves
    check (union_leg_cents + athlete_pool_cents = royalty_pool_cents)
);

comment on table public.sports_group_licensing_applications is
  'The append-only group licensing routing truth (migration 0054) — video game, trading card, and apparel royalties routing the contract-specified share to the union and players association ledgers (NFLPA, NBAPA) and the remainder equally across the listed athlete digital wallets. UNIQUE (source_event_id): the replay guard. The CHECK pins the union leg plus the athlete pool into the royalty pot.';

-- ---------------------------------------------------------------------------
-- sports_nil_deal_reconciliations: the NIL deal waterfall
-- reconciliation of record — the three legs against the profile.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_nil_deal_reconciliations (
  id                          uuid primary key default gen_random_uuid(),
  source_event_id             text not null,
  nil_contract_id             text not null,
  athlete_glan                text not null,
  period                      text not null,
  endorsement_deal_cents      bigint not null,
  booster_collective_cents    bigint not null,
  fan_club_subscription_cents bigint not null,
  nil_deal_gross_cents        bigint not null,
  verdict                     text not null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (source_event_id),
  unique (nil_contract_id, athlete_glan, period),
  constraint ck_sports_nil_deal_reconciliations_contract_present
    check (char_length(nil_contract_id) > 0),
  constraint ck_sports_nil_deal_reconciliations_athlete_present
    check (char_length(athlete_glan) > 0),
  constraint ck_sports_nil_deal_reconciliations_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_sports_nil_deal_reconciliations_endorsement_non_negative
    check (endorsement_deal_cents >= 0),
  constraint ck_sports_nil_deal_reconciliations_booster_non_negative
    check (booster_collective_cents >= 0),
  constraint ck_sports_nil_deal_reconciliations_fan_club_non_negative
    check (fan_club_subscription_cents >= 0),
  constraint ck_sports_nil_deal_reconciliations_gross_non_negative
    check (nil_deal_gross_cents >= 0),
  constraint ck_sports_nil_deal_reconciliations_verdict_vocabulary
    check (verdict IN ('reconciled', 'unmatched_profile', 'profile_ineligible')),
  constraint ck_sports_nil_deal_reconciliations_gross_conserves
    check (
      nil_deal_gross_cents
      = endorsement_deal_cents + booster_collective_cents
        + fan_club_subscription_cents
    )
);

comment on table public.sports_nil_deal_reconciliations is
  'The NIL deal waterfall reconciliation of record per (nil_contract_id, athlete_glan, period) (migration 0054) — the corporate endorsement, booster collective, and fan-club legs against the student-athlete profile, with the unmatched/ineligible verdicts the fail-closed resolution flags. UNIQUE (nil_contract_id, athlete_glan, period): the recompute replaces the position in place. The CHECK pins the gross as the sum of the three legs.';

-- ---------------------------------------------------------------------------
-- sports_biometric_micro_payout_applications: the append-only biometric
-- micro-payout truth — the pot and its two legs.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_biometric_micro_payout_applications (
  id                        uuid primary key default gen_random_uuid(),
  source_event_id           text not null,
  biometric_post_event_id   text not null,
  athlete_glan              text not null,
  league_rights_code        text not null,
  tracking_modality         text not null,
  licensee_class            text not null,
  licensed_quantity_micros  bigint not null,
  micros_per_unit           bigint not null,
  athlete_share_bps         bigint not null,
  payout_pot_cents          bigint not null,
  athlete_wallet_payee_id   text not null,
  athlete_leg_cents         bigint not null,
  league_data_payee_id      text not null,
  league_leg_cents          bigint not null,
  created_at                timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_sports_biometric_micro_payout_applications_post_event_present
    check (char_length(biometric_post_event_id) > 0),
  constraint ck_sports_biometric_micro_payout_applications_athlete_present
    check (char_length(athlete_glan) > 0),
  constraint ck_sports_biometric_micro_payout_applications_league_present
    check (char_length(league_rights_code) > 0),
  constraint ck_sports_biometric_micro_payout_applications_modality_vocabulary
    check (tracking_modality IN ('wearable', 'optical')),
  constraint ck_sports_biometric_micro_payout_applications_licensee_vocabulary
    check (licensee_class IN ('sportsbook', 'media_network', 'health_tech')),
  constraint ck_sports_biometric_micro_payout_applications_quantity_positive
    check (licensed_quantity_micros >= 1),
  constraint ck_sports_biometric_micro_payout_applications_rate_positive
    check (micros_per_unit >= 1),
  constraint ck_sports_biometric_micro_payout_applications_athlete_share_in_band
    check (athlete_share_bps >= 0 AND athlete_share_bps <= 10000),
  constraint ck_sports_biometric_micro_payout_applications_pot_non_negative
    check (payout_pot_cents >= 0),
  constraint ck_sports_biometric_micro_payout_applications_wallet_present
    check (char_length(athlete_wallet_payee_id) > 0),
  constraint ck_sports_biometric_micro_payout_applications_athlete_leg_non_negative
    check (athlete_leg_cents >= 0),
  constraint ck_sports_biometric_micro_payout_applications_league_payee_present
    check (char_length(league_data_payee_id) > 0),
  constraint ck_sports_biometric_micro_payout_applications_league_leg_non_negative
    check (league_leg_cents >= 0),
  constraint ck_sports_biometric_micro_payout_applications_legs_conserve
    check (athlete_leg_cents + league_leg_cents = payout_pot_cents)
);

comment on table public.sports_biometric_micro_payout_applications is
  'The append-only biometric micro-payout truth (migration 0054) — one row per licensed tracking post''s per-license micro-payout: the pot and its athlete digital wallet leg and league data rights holder leg. UNIQUE (source_event_id): the replay guard. The CHECK pins the two legs into the pot.';

-- =============================================================================
-- ROW LEVEL SECURITY — deny-all. The service role reaches these tables
-- through the store's service client; no other role reads or writes.
-- =============================================================================

alter table public.sports_student_athlete_profiles enable row level security;
drop policy if exists sports_student_athlete_profiles_service_role_all
  on public.sports_student_athlete_profiles;
create policy sports_student_athlete_profiles_service_role_all
  on public.sports_student_athlete_profiles
  for all
  using (false)
  with check (false);

alter table public.sports_resale_royalty_policies enable row level security;
drop policy if exists sports_resale_royalty_policies_service_role_all
  on public.sports_resale_royalty_policies;
create policy sports_resale_royalty_policies_service_role_all
  on public.sports_resale_royalty_policies
  for all
  using (false)
  with check (false);

alter table public.sports_league_pool_policies enable row level security;
drop policy if exists sports_league_pool_policies_service_role_all
  on public.sports_league_pool_policies;
create policy sports_league_pool_policies_service_role_all
  on public.sports_league_pool_policies
  for all
  using (false)
  with check (false);

alter table public.sports_league_team_registrations enable row level security;
drop policy if exists sports_league_team_registrations_service_role_all
  on public.sports_league_team_registrations;
create policy sports_league_team_registrations_service_role_all
  on public.sports_league_team_registrations
  for all
  using (false)
  with check (false);

alter table public.sports_biometric_royalty_policies enable row level security;
drop policy if exists sports_biometric_royalty_policies_service_role_all
  on public.sports_biometric_royalty_policies;
create policy sports_biometric_royalty_policies_service_role_all
  on public.sports_biometric_royalty_policies
  for all
  using (false)
  with check (false);

alter table public.sports_ticket_sale_posts enable row level security;
drop policy if exists sports_ticket_sale_posts_service_role_all
  on public.sports_ticket_sale_posts;
create policy sports_ticket_sale_posts_service_role_all
  on public.sports_ticket_sale_posts
  for all
  using (false)
  with check (false);

alter table public.sports_resale_sale_posts enable row level security;
drop policy if exists sports_resale_sale_posts_service_role_all
  on public.sports_resale_sale_posts;
create policy sports_resale_sale_posts_service_role_all
  on public.sports_resale_sale_posts
  for all
  using (false)
  with check (false);

alter table public.sports_turnstile_scan_posts enable row level security;
drop policy if exists sports_turnstile_scan_posts_service_role_all
  on public.sports_turnstile_scan_posts;
create policy sports_turnstile_scan_posts_service_role_all
  on public.sports_turnstile_scan_posts
  for all
  using (false)
  with check (false);

alter table public.sports_biometric_tracking_posts enable row level security;
drop policy if exists sports_biometric_tracking_posts_service_role_all
  on public.sports_biometric_tracking_posts;
create policy sports_biometric_tracking_posts_service_role_all
  on public.sports_biometric_tracking_posts
  for all
  using (false)
  with check (false);

alter table public.sports_broadcasting_contracts enable row level security;
drop policy if exists sports_broadcasting_contracts_service_role_all
  on public.sports_broadcasting_contracts;
create policy sports_broadcasting_contracts_service_role_all
  on public.sports_broadcasting_contracts
  for all
  using (false)
  with check (false);

alter table public.sports_gate_reconciliations enable row level security;
drop policy if exists sports_gate_reconciliations_service_role_all
  on public.sports_gate_reconciliations;
create policy sports_gate_reconciliations_service_role_all
  on public.sports_gate_reconciliations
  for all
  using (false)
  with check (false);

alter table public.sports_net_venue_realizations enable row level security;
drop policy if exists sports_net_venue_realizations_service_role_all
  on public.sports_net_venue_realizations;
create policy sports_net_venue_realizations_service_role_all
  on public.sports_net_venue_realizations
  for all
  using (false)
  with check (false);

alter table public.sports_resale_royalty_applications enable row level security;
drop policy if exists sports_resale_royalty_applications_service_role_all
  on public.sports_resale_royalty_applications;
create policy sports_resale_royalty_applications_service_role_all
  on public.sports_resale_royalty_applications
  for all
  using (false)
  with check (false);

alter table public.sports_league_pool_distributions enable row level security;
drop policy if exists sports_league_pool_distributions_service_role_all
  on public.sports_league_pool_distributions;
create policy sports_league_pool_distributions_service_role_all
  on public.sports_league_pool_distributions
  for all
  using (false)
  with check (false);

alter table public.sports_group_licensing_applications enable row level security;
drop policy if exists sports_group_licensing_applications_service_role_all
  on public.sports_group_licensing_applications;
create policy sports_group_licensing_applications_service_role_all
  on public.sports_group_licensing_applications
  for all
  using (false)
  with check (false);

alter table public.sports_nil_deal_reconciliations enable row level security;
drop policy if exists sports_nil_deal_reconciliations_service_role_all
  on public.sports_nil_deal_reconciliations;
create policy sports_nil_deal_reconciliations_service_role_all
  on public.sports_nil_deal_reconciliations
  for all
  using (false)
  with check (false);

alter table public.sports_biometric_micro_payout_applications enable row level security;
drop policy if exists sports_biometric_micro_payout_applications_service_role_all
  on public.sports_biometric_micro_payout_applications;
create policy sports_biometric_micro_payout_applications_service_role_all
  on public.sports_biometric_micro_payout_applications
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.sports_student_athlete_profiles to service_role;
grant select, insert, update, delete on public.sports_resale_royalty_policies to service_role;
grant select, insert, update, delete on public.sports_league_pool_policies to service_role;
grant select, insert, update, delete on public.sports_league_team_registrations to service_role;
grant select, insert, update, delete on public.sports_biometric_royalty_policies to service_role;
grant select, insert, update, delete on public.sports_ticket_sale_posts to service_role;
grant select, insert, update, delete on public.sports_resale_sale_posts to service_role;
grant select, insert, update, delete on public.sports_turnstile_scan_posts to service_role;
grant select, insert, update, delete on public.sports_biometric_tracking_posts to service_role;
grant select, insert, update, delete on public.sports_broadcasting_contracts to service_role;
grant select, insert, update, delete on public.sports_gate_reconciliations to service_role;
grant select, insert, update, delete on public.sports_net_venue_realizations to service_role;
grant select, insert, update, delete on public.sports_resale_royalty_applications to service_role;
grant select, insert, update, delete on public.sports_league_pool_distributions to service_role;
grant select, insert, update, delete on public.sports_group_licensing_applications to service_role;
grant select, insert, update, delete on public.sports_nil_deal_reconciliations to service_role;
grant select, insert, update, delete on public.sports_biometric_micro_payout_applications to service_role;

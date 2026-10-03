-- =============================================================================
-- 0042 — The fitness lane's durable facts of record (PR 38)
--
-- The founder fitness directive, per the brief. Sixteen tables:
--
--   fitness_trainer_tier_schedules   <- upsertFitnessTrainerTierSchedule /
--                                       getFitnessTrainerTierSchedule
--     (the trainer+program royalty tier schedule of record: the ordered
--      per-completion bands as JSON text — e.g. $0.05 per completed class
--      stream scaling to $0.12 past 100,000 monthly completions — plus the
--      subscriber retention bonus micro-fee. UNIQUE per (trainer_id,
--      program_id): an upsert converges — the newest schedule governs the
--      next walk. ABSENT schedule = no royalty — fail-closed.)
--
--   fitness_completion_months        <- advanceFitnessCompletionMonth /
--                                       getFitnessCompletionMonth
--     (the cumulative monthly completions tracker per (trainer_id,
--      program_id, month) — the position the tier walk prices from and the
--      boundary (100,000) is honored CUMULATIVELY across rows within the
--      month. UNIQUE per (trainer_id, program_id, month); the advance is an
--      atomic read-modify-upsert.)
--
--   fitness_sync_music_policies      <- upsertFitnessSyncMusicPolicy /
--                                       getFitnessSyncMusicPolicy
--     (the program's sync music policy of record: master and publishing
--      performance royalty micro-fees per workout, deducted DIRECTLY from
--      class revenue BEFORE the trainer net. UNIQUE per program_id. ABSENT
--      policy = no music deduction of record and no royalty — fail-closed;
--      a zero-rate policy is the operator's explicit statement.)
--
--   fitness_live_load_policies       <- upsertFitnessLiveLoadPolicy /
--                                       getFitnessLiveLoadPolicy
--     (the program's live-event server load policy of record: the ordered
--      peak-simultaneous-viewer bands as JSON text — e.g. 50,000 viewers
--      on a weekend broadcast. UNIQUE per program_id. ABSENT policy = no
--      residual — fail-closed.)
--
--   fitness_franchise_policies       <- upsertFitnessFranchisePolicy /
--                                       getFitnessFranchisePolicy
--     (the studio franchise policy of record per studio_franchise_code:
--      the franchise license override bps (applied on certified workout
--      choreographies and audio tracks) and the studio network fee bps —
--      BOTH deducted prior to the instructor disbursement. UNIQUE per
--      studio_franchise_code. ABSENT policy = no override walk —
--      fail-closed.)
--
--   fitness_franchise_class_months   <- advanceFitnessFranchiseClassMonth /
--                                       getFitnessFranchiseClassMonth
--     (the cumulative monthly class count tracker per (studio_franchise_code,
--      month) — the physical franchise location class counts of record.
--      UNIQUE per (studio_franchise_code, month).)
--
--   fitness_co_brand_partnerships    <- upsertFitnessCoBrandPartnership /
--                                       getFitnessCoBrandPartnership
--     (the studio-to-app partnership of record per studio_franchise_code —
--      e.g. a boutique gym brand × an at-home bike platform: the brick-
--      and-mortar IP owner and the digital distributor split the net class
--      stream earnings; shares sum to exactly 10,000 bps (pinned). UNIQUE
--      per studio_franchise_code. ABSENT partnership = no split —
--      fail-closed.)
--
--   fitness_algorithm_policies       <- upsertFitnessAlgorithmPolicy /
--                                       getFitnessAlgorithmPolicy
--     (the wearable biometric / algorithm micro-royalty policy of record
--      per program: the payee of record (the algorithm creator or
--      celebrity sports scientist) and the per-active-user micro-fee.
--      UNIQUE per program_id. ABSENT policy = no micro-royalty —
--      fail-closed.)
--
--   fitness_cocreation_modules       <- upsertFitnessCocreationModule /
--                                       listFitnessCocreationModules
--     (the multi-trainer co-creation waterfall of record per program —
--      e.g. a 12-week marathon prep course by 3 elite coaches: ordered
--      (module_id, trainer_id, weight_bps) legs. UNIQUE per (program_id,
--      module_id). ABSENT legs = the pool splits nowhere — fail-closed;
--      weights are re-validated at read.)
--
--   fitness_realization_applications <- insertFitnessRealizationApplication /
--                                       getFitnessRealizationApplication
--     (the append-only Digital Stream Realization of record per source
--      event: gross subscription pool − app store engine cut − digital
--      infrastructure overhead = Net Fitness Content Pool, the identity
--      pinned in a CHECK. UNIQUE per source_event_id is the replay guard —
--      a re-shipped sheet throws, never a double realization. A negative
--      pool HOLDS (verdict 'held_negative_net', visible, no split).)
--
--   fitness_trainer_royalty_applications
--                                    <- insertFitnessTrainerRoyaltyApplication /
--                                       getFitnessTrainerRoyaltyApplication
--     (the append-only trainer royalty application of record per source
--      event: the sync music legs deducted FIRST, the trainer net basis,
--      the tier walk's committed legs with the cumulative monthly position
--      before/after, and the retention bonus. UNIQUE per source_event_id is
--      the replay guard. The sync-BEFORE-net ordering and the held shape
--      are pinned in CHECKs.)
--
--   fitness_live_residual_applications
--                                    <- insertFitnessLiveResidualApplication /
--                                       getFitnessLiveResidualApplication
--     (the append-only live-event streaming residual of record per source
--      event: the load band at the peak viewers, the server load
--      deduction, and the net residual. UNIQUE per source_event_id is the
--      replay guard; the arithmetic (net = revenue − deduction,
--      deduction ≤ revenue) is pinned in CHECKs.)
--
--   fitness_franchise_applications   <- insertFitnessFranchiseApplication /
--                                       getFitnessFranchiseApplication
--     (the append-only franchise override application of record per source
--      event: the certified-content override legs, the network fee, and
--      the instructor disbursement AFTER both. UNIQUE per source_event_id
--      is the replay guard. The override-before-disbursement ordering and
--      the held shape are pinned in CHECKs.)
--
--   fitness_cobrand_split_applications
--                                    <- insertFitnessCobrandSplitApplication /
--                                       getFitnessCobrandSplitApplication
--     (the append-only co-branded franchise split of record per source
--      event: the net class stream earnings and the IP owner / distributor
--      cents. UNIQUE per source_event_id is the replay guard; the shares
--      sum to 10,000 bps and the split conserves its basis exactly — both
--      pinned in CHECKs.)
--
--   fitness_algorithm_royalty_ledger <- insertFitnessAlgorithmRoyalty /
--                                       getFitnessAlgorithmRoyalty
--     (the append-only wearable / algorithm micro-royalty of record per
--      source event: the daily active feature usage and the payee. UNIQUE
--      per source_event_id is the replay guard.)
--
--   fitness_cocreation_applications  <- insertFitnessCocreationApplication /
--                                       getFitnessCocreationApplication
--     (the append-only co-creation split of record per source event: the
--      realized pool and the module-weighted waterfall legs — largest-
--      remainder exact, the allocation conserving its basis (pinned in a
--      CHECK). UNIQUE per source_event_id is the replay guard.)
--
-- The 0032 lesson, applied: every CHECK is an explicitly named TABLE-level
-- constraint (ck_*) — column-level checks collide with table-level ones of
-- the same shape. No foreign keys by design — the tables key on
-- content-derived event ids, the senders' trainer/program/franchise
-- identifiers, and reporting months (the 0036–0041 discipline).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- fitness_trainer_tier_schedules: the royalty tier schedule of record per
-- (trainer, program) — the per-completion bands and the retention bonus.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_trainer_tier_schedules (
  id                                  uuid primary key default gen_random_uuid(),
  trainer_id                          text not null,
  program_id                          text not null,
  bands                               text not null,
  retention_bonus_micros_per_completion bigint not null,
  created_at                          timestamptz not null default now(),
  updated_at                          timestamptz not null default now(),
  unique (trainer_id, program_id),
  constraint ck_fitness_trainer_tier_schedules_trainer_present
    check (char_length(trainer_id) > 0),
  constraint ck_fitness_trainer_tier_schedules_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_trainer_tier_schedules_bands_present
    check (char_length(bands) > 0),
  constraint ck_fitness_trainer_tier_schedules_retention_nonneg
    check (retention_bonus_micros_per_completion >= 0)
);

comment on table public.fitness_trainer_tier_schedules is
  'The trainer+program royalty tier schedule of record (migration 0042): the ordered per-completion bands as JSON text — e.g. $0.05 per completed class stream scaling to $0.12 past 100,000 monthly completions — plus the subscriber retention bonus micro-fee. UNIQUE (trainer_id, program_id): an upsert converges — the newest schedule governs the next walk. ABSENT schedule = no royalty (fail-closed).';

-- ---------------------------------------------------------------------------
-- fitness_completion_months: the cumulative monthly completions tracker per
-- (trainer, program, month) — the tier boundary is honored cumulatively.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_completion_months (
  id                     uuid primary key default gen_random_uuid(),
  trainer_id             text not null,
  program_id             text not null,
  month                  text not null,
  cumulative_completions bigint not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (trainer_id, program_id, month),
  constraint ck_fitness_completion_months_month_format
    check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint ck_fitness_completion_months_cumulative_nonneg
    check (cumulative_completions >= 0)
);

comment on table public.fitness_completion_months is
  'The cumulative monthly completions tracker (migration 0042) per (trainer_id, program_id, month): the position the tier walk prices from — the $0.05 → $0.12 boundary at 100,000 monthly completions is honored cumulatively across rows within the month. UNIQUE (trainer_id, program_id, month); the advance is an atomic read-modify-upsert.';

-- ---------------------------------------------------------------------------
-- fitness_sync_music_policies: the sync music policy of record per program.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_sync_music_policies (
  id                                  uuid primary key default gen_random_uuid(),
  program_id                          text not null,
  master_royalty_micros_per_workout   bigint not null,
  publishing_royalty_micros_per_workout bigint not null,
  created_at                          timestamptz not null default now(),
  updated_at                          timestamptz not null default now(),
  unique (program_id),
  constraint ck_fitness_sync_music_policies_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_sync_music_policies_master_nonneg
    check (master_royalty_micros_per_workout >= 0),
  constraint ck_fitness_sync_music_policies_publishing_nonneg
    check (publishing_royalty_micros_per_workout >= 0)
);

comment on table public.fitness_sync_music_policies is
  'The program''s sync music policy of record (migration 0042): master and publishing performance royalty micro-fees per workout, deducted DIRECTLY from class revenue BEFORE the trainer net. UNIQUE (program_id). ABSENT policy = no music deduction of record and no royalty (fail-closed); a zero-rate policy is the operator''s explicit statement.';

-- ---------------------------------------------------------------------------
-- fitness_live_load_policies: the live-event server load policy of record
-- per program — the ordered peak-viewer bands.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_live_load_policies (
  id          uuid primary key default gen_random_uuid(),
  program_id  text not null,
  bands       text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (program_id),
  constraint ck_fitness_live_load_policies_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_live_load_policies_bands_present
    check (char_length(bands) > 0)
);

comment on table public.fitness_live_load_policies is
  'The program''s live-event server load policy of record (migration 0042): the ordered peak-simultaneous-viewer bands as JSON text — e.g. 50,000 simultaneous users on a weekend broadcast class. UNIQUE (program_id). ABSENT policy = no residual (fail-closed).';

-- ---------------------------------------------------------------------------
-- fitness_franchise_policies: the studio franchise policy of record per
-- franchise code — the certified-content override and the network fee.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_franchise_policies (
  id                            uuid primary key default gen_random_uuid(),
  studio_franchise_code         text not null,
  franchise_license_override_bps bigint not null,
  network_fee_bps               bigint not null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique (studio_franchise_code),
  constraint ck_fitness_franchise_policies_code_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_franchise_policies_override_bps_range
    check (franchise_license_override_bps >= 0 AND franchise_license_override_bps <= 10000),
  constraint ck_fitness_franchise_policies_network_fee_bps_range
    check (network_fee_bps >= 0 AND network_fee_bps <= 10000)
);

comment on table public.fitness_franchise_policies is
  'The studio franchise policy of record (migration 0042) per studio_franchise_code: the franchise license override bps (applied on certified workout choreographies and audio tracks) and the studio network fee bps — BOTH deducted prior to the instructor disbursement. UNIQUE (studio_franchise_code). ABSENT policy = no override walk (fail-closed).';

-- ---------------------------------------------------------------------------
-- fitness_franchise_class_months: the cumulative monthly class count tracker
-- per (franchise code, month) — the physical location class counts.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_franchise_class_months (
  id                 uuid primary key default gen_random_uuid(),
  studio_franchise_code text not null,
  month              text not null,
  cumulative_classes bigint not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (studio_franchise_code, month),
  constraint ck_fitness_franchise_class_months_month_format
    check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint ck_fitness_franchise_class_months_cumulative_nonneg
    check (cumulative_classes >= 0)
);

comment on table public.fitness_franchise_class_months is
  'The cumulative monthly class count tracker (migration 0042) per (studio_franchise_code, month): the physical franchise location class counts of record. UNIQUE (studio_franchise_code, month); the advance is an atomic read-modify-upsert.';

-- ---------------------------------------------------------------------------
-- fitness_co_brand_partnerships: the studio-to-app partnership of record per
-- franchise code — the IP owner and distributor share split.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_co_brand_partnerships (
  id                    uuid primary key default gen_random_uuid(),
  studio_franchise_code text not null,
  ip_owner_id           text not null,
  distributor_id        text not null,
  ip_owner_share_bps    bigint not null,
  distributor_share_bps bigint not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (studio_franchise_code),
  constraint ck_fitness_co_brand_partnerships_code_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_co_brand_partnerships_ip_owner_present
    check (char_length(ip_owner_id) > 0),
  constraint ck_fitness_co_brand_partnerships_distributor_present
    check (char_length(distributor_id) > 0),
  constraint ck_fitness_co_brand_partnerships_ip_owner_share_range
    check (ip_owner_share_bps > 0 AND ip_owner_share_bps < 10000),
  constraint ck_fitness_co_brand_partnerships_distributor_share_range
    check (distributor_share_bps > 0 AND distributor_share_bps < 10000),
  constraint ck_fitness_co_brand_partnerships_shares_sum
    check (ip_owner_share_bps + distributor_share_bps = 10000)
);

comment on table public.fitness_co_brand_partnerships is
  'The studio-to-app partnership of record (migration 0042) per studio_franchise_code — e.g. a boutique gym brand × an at-home bike platform: the brick-and-mortar IP owner and the digital distributor split the net class stream earnings; shares sum to exactly 10,000 bps (pinned). UNIQUE (studio_franchise_code). ABSENT partnership = no split (fail-closed).';

-- ---------------------------------------------------------------------------
-- fitness_algorithm_policies: the wearable / algorithm micro-royalty policy
-- of record per program.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_algorithm_policies (
  id                     uuid primary key default gen_random_uuid(),
  program_id             text not null,
  algorithm_creator_id   text not null,
  micros_per_active_user bigint not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (program_id),
  constraint ck_fitness_algorithm_policies_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_algorithm_policies_creator_present
    check (char_length(algorithm_creator_id) > 0),
  constraint ck_fitness_algorithm_policies_micros_positive
    check (micros_per_active_user > 0)
);

comment on table public.fitness_algorithm_policies is
  'The wearable biometric / algorithm micro-royalty policy of record (migration 0042) per program: the payee of record (the algorithm creator or celebrity sports scientist) and the per-active-user micro-fee priced from daily active feature usage. UNIQUE (program_id). ABSENT policy = no micro-royalty (fail-closed).';

-- ---------------------------------------------------------------------------
-- fitness_cocreation_modules: the multi-trainer co-creation waterfall of
-- record per program — the ordered module weightings.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_cocreation_modules (
  id          uuid primary key default gen_random_uuid(),
  program_id  text not null,
  module_id   text not null,
  trainer_id  text not null,
  weight_bps  bigint not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (program_id, module_id),
  constraint ck_fitness_cocreation_modules_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_cocreation_modules_module_present
    check (char_length(module_id) > 0),
  constraint ck_fitness_cocreation_modules_trainer_present
    check (char_length(trainer_id) > 0),
  constraint ck_fitness_cocreation_modules_weight_range
    check (weight_bps > 0 AND weight_bps <= 10000)
);

comment on table public.fitness_cocreation_modules is
  'The multi-trainer co-creation waterfall of record (migration 0042) per program — e.g. a 12-week marathon prep course by 3 elite coaches: ordered (module_id, trainer_id, weight_bps) legs. UNIQUE (program_id, module_id). ABSENT legs = the pool splits nowhere (fail-closed); weights are re-validated at read.';

-- ---------------------------------------------------------------------------
-- fitness_realization_applications: the append-only Digital Stream
-- Realization of record per source event — replay-guarded.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_realization_applications (
  id                                    uuid primary key default gen_random_uuid(),
  source_event_id                       text not null,
  trainer_id                            text not null,
  program_id                            text not null,
  studio_franchise_code                 text not null,
  period                                text not null,
  currency                              text not null,
  gross_subscription_pool_cents         bigint not null,
  app_store_engine_cut_cents            bigint not null,
  digital_infrastructure_overhead_cents bigint not null,
  net_fitness_content_pool_cents        bigint not null,
  verdict                               text not null,
  created_at                            timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_fitness_realization_applications_trainer_present
    check (char_length(trainer_id) > 0),
  constraint ck_fitness_realization_applications_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_realization_applications_code_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_realization_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_fitness_realization_applications_gross_nonneg
    check (gross_subscription_pool_cents >= 0),
  constraint ck_fitness_realization_applications_cut_nonneg
    check (app_store_engine_cut_cents >= 0),
  constraint ck_fitness_realization_applications_overhead_nonneg
    check (digital_infrastructure_overhead_cents >= 0),
  constraint ck_fitness_realization_applications_verdict
    check (verdict in ('paid', 'held_negative_net')),
  constraint ck_fitness_realization_applications_realization_identity
    check (net_fitness_content_pool_cents = gross_subscription_pool_cents
      - app_store_engine_cut_cents - digital_infrastructure_overhead_cents)
);

comment on table public.fitness_realization_applications is
  'The append-only Digital Stream Realization of record (migration 0042) per source event: gross subscription pool − app store engine cut − digital infrastructure overhead = Net Fitness Content Pool, the identity pinned in a CHECK. UNIQUE (source_event_id) is the replay guard — a re-shipped sheet throws, never a double realization. A negative pool HOLDS (verdict ''held_negative_net'', visible, no split).';

-- ---------------------------------------------------------------------------
-- fitness_trainer_royalty_applications: the append-only trainer royalty of
-- record per source event — sync music FIRST, then the tier walk.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_trainer_royalty_applications (
  id                                    uuid primary key default gen_random_uuid(),
  source_event_id                       text not null,
  sender                                text not null,
  trainer_id                            text not null,
  program_id                            text not null,
  studio_franchise_code                 text not null,
  period                                text not null,
  currency                              text not null,
  completed_count                       bigint not null,
  class_revenue_cents                   bigint not null,
  sync_policy_ref                       text,
  master_royalty_micros_per_workout     bigint not null,
  publishing_royalty_micros_per_workout bigint not null,
  sync_master_micros                    bigint not null,
  sync_publishing_micros                bigint not null,
  sync_master_cents                     bigint not null,
  sync_publishing_cents                 bigint not null,
  trainer_net_basis_cents               bigint not null,
  tier_schedule_ref                     text,
  tier_legs                             text not null,
  tier_payout_micros                    bigint not null,
  tier_payout_cents                     bigint not null,
  retained_count                        bigint not null,
  retention_bonus_micros_per_completion bigint not null,
  retention_bonus_micros                bigint not null,
  retention_bonus_cents                 bigint not null,
  monthly_completions_before            bigint,
  monthly_completions_after             bigint,
  verdict                               text not null,
  created_at                            timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_fitness_trainer_royalty_applications_sender
    check (sender in ('stream_start', 'workout_complete')),
  constraint ck_fitness_trainer_royalty_applications_trainer_present
    check (char_length(trainer_id) > 0),
  constraint ck_fitness_trainer_royalty_applications_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_trainer_royalty_applications_code_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_trainer_royalty_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_fitness_trainer_royalty_applications_completed_positive
    check (completed_count > 0),
  constraint ck_fitness_trainer_royalty_applications_class_revenue_nonneg
    check (class_revenue_cents >= 0),
  constraint ck_fitness_trainer_royalty_applications_master_rate_nonneg
    check (master_royalty_micros_per_workout >= 0),
  constraint ck_fitness_trainer_royalty_applications_publishing_rate_nonneg
    check (publishing_royalty_micros_per_workout >= 0),
  constraint ck_fitness_trainer_royalty_applications_sync_master_nonneg
    check (sync_master_micros >= 0),
  constraint ck_fitness_trainer_royalty_applications_sync_publishing_nonneg
    check (sync_publishing_micros >= 0),
  constraint ck_fitness_trainer_royalty_applications_sync_master_cents_nonneg
    check (sync_master_cents >= 0),
  constraint ck_fitness_trainer_royalty_applications_sync_publishing_cents_nonneg
    check (sync_publishing_cents >= 0),
  constraint ck_fitness_trainer_royalty_applications_tier_payout_nonneg
    check (tier_payout_micros >= 0),
  constraint ck_fitness_trainer_royalty_applications_tier_payout_cents_nonneg
    check (tier_payout_cents >= 0),
  constraint ck_fitness_trainer_royalty_applications_retained_nonneg
    check (retained_count >= 0),
  constraint ck_fitness_trainer_royalty_applications_retention_rate_nonneg
    check (retention_bonus_micros_per_completion >= 0),
  constraint ck_fitness_trainer_royalty_applications_retention_micros_nonneg
    check (retention_bonus_micros >= 0),
  constraint ck_fitness_trainer_royalty_applications_retention_cents_nonneg
    check (retention_bonus_cents >= 0),
  constraint ck_fitness_trainer_royalty_applications_verdict
    check (verdict in ('paid', 'held_negative_net')),
  constraint ck_fitness_trainer_royalty_applications_retained_capped
    check (retained_count <= completed_count),
  constraint ck_fitness_trainer_royalty_applications_sync_before_net
    check (trainer_net_basis_cents = class_revenue_cents
      - sync_master_cents - sync_publishing_cents),
  constraint ck_fitness_trainer_royalty_applications_held_shape
    check (verdict = 'paid' OR (trainer_net_basis_cents < 0
      AND tier_payout_micros = 0 AND tier_payout_cents = 0
      AND retention_bonus_micros = 0 AND retention_bonus_cents = 0
      AND monthly_completions_before IS NULL
      AND monthly_completions_after IS NULL))
);

comment on table public.fitness_trainer_royalty_applications is
  'The append-only trainer royalty application of record (migration 0042) per source event: the sync music legs deducted FIRST (master + publishing off the class revenue BEFORE the trainer net — the ordering pinned in a CHECK), the trainer net basis, the tier walk''s committed legs with the cumulative monthly position before/after, and the subscriber retention bonus. UNIQUE (source_event_id) is the replay guard. Negative-net events hold (verdict ''held_negative_net'') with zeroed royalty legs and no tracker advance.';

-- ---------------------------------------------------------------------------
-- fitness_live_residual_applications: the append-only live-event residual
-- of record per source event — replay-guarded.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_live_residual_applications (
  id                          uuid primary key default gen_random_uuid(),
  source_event_id             text not null,
  trainer_id                  text not null,
  program_id                  text not null,
  studio_franchise_code       text not null,
  period                      text not null,
  currency                    text not null,
  peak_simultaneous_viewers   bigint not null,
  live_event_revenue_cents    bigint not null,
  load_band_from              bigint not null,
  load_band_to                bigint,
  server_load_bps             bigint not null,
  server_load_deduction_cents bigint not null,
  net_live_residual_cents     bigint not null,
  created_at                  timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_fitness_live_residual_applications_trainer_present
    check (char_length(trainer_id) > 0),
  constraint ck_fitness_live_residual_applications_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_live_residual_applications_code_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_live_residual_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_fitness_live_residual_applications_viewers_positive
    check (peak_simultaneous_viewers > 0),
  constraint ck_fitness_live_residual_applications_revenue_nonneg
    check (live_event_revenue_cents >= 0),
  constraint ck_fitness_live_residual_applications_band_from_nonneg
    check (load_band_from >= 0),
  constraint ck_fitness_live_residual_applications_bps_range
    check (server_load_bps >= 0 AND server_load_bps <= 10000),
  constraint ck_fitness_live_residual_applications_deduction_nonneg
    check (server_load_deduction_cents >= 0),
  constraint ck_fitness_live_residual_applications_residual_arithmetic
    check (net_live_residual_cents = live_event_revenue_cents
      - server_load_deduction_cents),
  constraint ck_fitness_live_residual_applications_deduction_capped
    check (server_load_deduction_cents <= live_event_revenue_cents)
);

comment on table public.fitness_live_residual_applications is
  'The append-only live-event streaming residual of record (migration 0042) per source event: the load band at the peak simultaneous viewers (the band''s bps floors off the live event revenue), the server load deduction, and the net residual. UNIQUE (source_event_id) is the replay guard; the arithmetic (net = revenue − deduction, deduction ≤ revenue) is pinned in CHECKs.';

-- ---------------------------------------------------------------------------
-- fitness_franchise_applications: the append-only franchise override of
-- record per source event — override + fee BEFORE the disbursement.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_franchise_applications (
  id                                    uuid primary key default gen_random_uuid(),
  source_event_id                       text not null,
  trainer_id                            text not null,
  program_id                            text not null,
  studio_franchise_code                 text not null,
  period                                text not null,
  currency                              text not null,
  class_count                           bigint not null,
  classes_before                        bigint,
  classes_after                         bigint,
  class_revenue_cents                   bigint not null,
  certified_choreography_revenue_cents  bigint not null,
  certified_audio_revenue_cents         bigint not null,
  franchise_license_override_bps        bigint not null,
  choreography_override_cents           bigint not null,
  audio_override_cents                  bigint not null,
  franchise_override_total_cents        bigint not null,
  network_fee_bps                       bigint not null,
  network_fee_cents                     bigint not null,
  instructor_disbursement_cents         bigint not null,
  verdict                               text not null,
  created_at                            timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_fitness_franchise_applications_trainer_present
    check (char_length(trainer_id) > 0),
  constraint ck_fitness_franchise_applications_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_franchise_applications_code_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_franchise_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_fitness_franchise_applications_class_count_positive
    check (class_count > 0),
  constraint ck_fitness_franchise_applications_class_revenue_nonneg
    check (class_revenue_cents >= 0),
  constraint ck_fitness_franchise_applications_choreography_revenue_nonneg
    check (certified_choreography_revenue_cents >= 0),
  constraint ck_fitness_franchise_applications_audio_revenue_nonneg
    check (certified_audio_revenue_cents >= 0),
  constraint ck_fitness_franchise_applications_override_bps_range
    check (franchise_license_override_bps >= 0
      AND franchise_license_override_bps <= 10000),
  constraint ck_fitness_franchise_applications_choreography_override_nonneg
    check (choreography_override_cents >= 0),
  constraint ck_fitness_franchise_applications_audio_override_nonneg
    check (audio_override_cents >= 0),
  constraint ck_fitness_franchise_applications_override_total_nonneg
    check (franchise_override_total_cents >= 0),
  constraint ck_fitness_franchise_applications_network_fee_bps_range
    check (network_fee_bps >= 0 AND network_fee_bps <= 10000),
  constraint ck_fitness_franchise_applications_network_fee_nonneg
    check (network_fee_cents >= 0),
  constraint ck_fitness_franchise_applications_verdict
    check (verdict in ('paid', 'held_negative_net')),
  constraint ck_fitness_franchise_applications_override_total_legs
    check (franchise_override_total_cents = choreography_override_cents
      + audio_override_cents),
  constraint ck_fitness_franchise_applications_disbursement_ordering
    check (instructor_disbursement_cents = class_revenue_cents
      - franchise_override_total_cents - network_fee_cents),
  constraint ck_fitness_franchise_applications_held_shape
    check (verdict = 'paid' OR (instructor_disbursement_cents < 0
      AND classes_before IS NULL AND classes_after IS NULL))
);

comment on table public.fitness_franchise_applications is
  'The append-only franchise override application of record (migration 0042) per source event: the certified-content override legs (choreography + audio), the studio network fee, and the instructor disbursement AFTER both (the ordering pinned in a CHECK), with the franchise-month class position before/after. UNIQUE (source_event_id) is the replay guard. Negative-disbursement events hold (verdict ''held_negative_net'') with no tracker advance.';

-- ---------------------------------------------------------------------------
-- fitness_cobrand_split_applications: the append-only co-branded split of
-- record per source event — basis-conserving.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_cobrand_split_applications (
  id                            uuid primary key default gen_random_uuid(),
  source_event_id               text not null,
  trainer_id                    text not null,
  program_id                    text not null,
  studio_franchise_code         text not null,
  period                        text not null,
  currency                      text not null,
  ip_owner_id                   text not null,
  distributor_id                text not null,
  net_class_stream_earnings_cents bigint not null,
  ip_owner_share_bps            bigint not null,
  distributor_share_bps         bigint not null,
  ip_owner_cents                bigint not null,
  distributor_cents             bigint not null,
  created_at                    timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_fitness_cobrand_split_applications_trainer_present
    check (char_length(trainer_id) > 0),
  constraint ck_fitness_cobrand_split_applications_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_cobrand_split_applications_code_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_cobrand_split_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_fitness_cobrand_split_applications_ip_owner_present
    check (char_length(ip_owner_id) > 0),
  constraint ck_fitness_cobrand_split_applications_distributor_present
    check (char_length(distributor_id) > 0),
  constraint ck_fitness_cobrand_split_applications_basis_nonneg
    check (net_class_stream_earnings_cents >= 0),
  constraint ck_fitness_cobrand_split_applications_ip_owner_share_range
    check (ip_owner_share_bps > 0 AND ip_owner_share_bps < 10000),
  constraint ck_fitness_cobrand_split_applications_distributor_share_range
    check (distributor_share_bps > 0 AND distributor_share_bps < 10000),
  constraint ck_fitness_cobrand_split_applications_shares_sum
    check (ip_owner_share_bps + distributor_share_bps = 10000),
  constraint ck_fitness_cobrand_split_applications_ip_owner_nonneg
    check (ip_owner_cents >= 0),
  constraint ck_fitness_cobrand_split_applications_distributor_nonneg
    check (distributor_cents >= 0),
  constraint ck_fitness_cobrand_split_applications_split_conserves_basis
    check (ip_owner_cents + distributor_cents = net_class_stream_earnings_cents)
);

comment on table public.fitness_cobrand_split_applications is
  'The append-only co-branded franchise split of record (migration 0042) per source event: the net class stream earnings (class revenue less the franchise legs) and the IP owner / distributor cents. UNIQUE (source_event_id) is the replay guard; the shares sum to 10,000 bps and the split conserves its basis exactly — both pinned in CHECKs.';

-- ---------------------------------------------------------------------------
-- fitness_algorithm_royalty_ledger: the append-only wearable / algorithm
-- micro-royalty of record per source event.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_algorithm_royalty_ledger (
  id                    uuid primary key default gen_random_uuid(),
  source_event_id       text not null,
  trainer_id            text not null,
  program_id            text not null,
  studio_franchise_code text not null,
  period                text not null,
  currency              text not null,
  equipment_type        text not null,
  equipment_id          text not null,
  wearable_active_users bigint not null,
  algorithm_creator_id  text not null,
  micros_per_active_user bigint not null,
  royalty_micros        bigint not null,
  royalty_cents         bigint not null,
  created_at            timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_fitness_algorithm_royalty_ledger_trainer_present
    check (char_length(trainer_id) > 0),
  constraint ck_fitness_algorithm_royalty_ledger_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_algorithm_royalty_ledger_code_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_algorithm_royalty_ledger_currency_present
    check (char_length(currency) > 0),
  constraint ck_fitness_algorithm_royalty_ledger_equipment_type
    check (equipment_type in ('connected_bike', 'treadmill')),
  constraint ck_fitness_algorithm_royalty_ledger_equipment_id_present
    check (char_length(equipment_id) > 0),
  constraint ck_fitness_algorithm_royalty_ledger_users_nonneg
    check (wearable_active_users >= 0),
  constraint ck_fitness_algorithm_royalty_ledger_creator_present
    check (char_length(algorithm_creator_id) > 0),
  constraint ck_fitness_algorithm_royalty_ledger_micros_positive
    check (micros_per_active_user > 0),
  constraint ck_fitness_algorithm_royalty_ledger_royalty_micros_nonneg
    check (royalty_micros >= 0),
  constraint ck_fitness_algorithm_royalty_ledger_royalty_cents_nonneg
    check (royalty_cents >= 0)
);

comment on table public.fitness_algorithm_royalty_ledger is
  'The append-only wearable / algorithm micro-royalty of record (migration 0042) per source event: the daily active feature usage (wearable active users), the payee of record (the algorithm creator or celebrity sports scientist), and the per-active-user priced royalty. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- fitness_cocreation_applications: the append-only co-creation split of
-- record per source event — basis-conserving.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_cocreation_applications (
  id                     uuid primary key default gen_random_uuid(),
  source_event_id        text not null,
  trainer_id             text not null,
  program_id             text not null,
  studio_franchise_code  text not null,
  period                 text not null,
  currency               text not null,
  enrollment_revenue_cents bigint not null,
  waterfall_legs         text not null,
  allocated_total_cents  bigint not null,
  created_at             timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_fitness_cocreation_applications_trainer_present
    check (char_length(trainer_id) > 0),
  constraint ck_fitness_cocreation_applications_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_cocreation_applications_code_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_cocreation_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_fitness_cocreation_applications_basis_nonneg
    check (enrollment_revenue_cents >= 0),
  constraint ck_fitness_cocreation_applications_legs_present
    check (char_length(waterfall_legs) > 0),
  constraint ck_fitness_cocreation_applications_allocated_nonneg
    check (allocated_total_cents >= 0),
  constraint ck_fitness_cocreation_applications_split_conserves_basis
    check (allocated_total_cents = enrollment_revenue_cents)
);

comment on table public.fitness_cocreation_applications is
  'The append-only co-creation split of record (migration 0042) per source event: the realized Net Fitness Content Pool and the module-weighted waterfall legs — largest-remainder exact, the allocation conserving its basis (pinned in a CHECK). UNIQUE (source_event_id) is the replay guard.';

-- Row Level Security — deny-all with the 0041 service-role grant set (the
-- lane writes through the service-role client only; no anon/authenticated
-- surface reads these tables).
alter table public.fitness_trainer_tier_schedules enable row level security;
alter table public.fitness_completion_months enable row level security;
alter table public.fitness_sync_music_policies enable row level security;
alter table public.fitness_live_load_policies enable row level security;
alter table public.fitness_franchise_policies enable row level security;
alter table public.fitness_franchise_class_months enable row level security;
alter table public.fitness_co_brand_partnerships enable row level security;
alter table public.fitness_algorithm_policies enable row level security;
alter table public.fitness_cocreation_modules enable row level security;
alter table public.fitness_realization_applications enable row level security;
alter table public.fitness_trainer_royalty_applications enable row level security;
alter table public.fitness_live_residual_applications enable row level security;
alter table public.fitness_franchise_applications enable row level security;
alter table public.fitness_cobrand_split_applications enable row level security;
alter table public.fitness_algorithm_royalty_ledger enable row level security;
alter table public.fitness_cocreation_applications enable row level security;

drop policy if exists fitness_trainer_tier_schedules_service_role_all
  on public.fitness_trainer_tier_schedules;
create policy fitness_trainer_tier_schedules_service_role_all
  on public.fitness_trainer_tier_schedules
  for all
  using (false)
  with check (false);

drop policy if exists fitness_completion_months_service_role_all
  on public.fitness_completion_months;
create policy fitness_completion_months_service_role_all
  on public.fitness_completion_months
  for all
  using (false)
  with check (false);

drop policy if exists fitness_sync_music_policies_service_role_all
  on public.fitness_sync_music_policies;
create policy fitness_sync_music_policies_service_role_all
  on public.fitness_sync_music_policies
  for all
  using (false)
  with check (false);

drop policy if exists fitness_live_load_policies_service_role_all
  on public.fitness_live_load_policies;
create policy fitness_live_load_policies_service_role_all
  on public.fitness_live_load_policies
  for all
  using (false)
  with check (false);

drop policy if exists fitness_franchise_policies_service_role_all
  on public.fitness_franchise_policies;
create policy fitness_franchise_policies_service_role_all
  on public.fitness_franchise_policies
  for all
  using (false)
  with check (false);

drop policy if exists fitness_franchise_class_months_service_role_all
  on public.fitness_franchise_class_months;
create policy fitness_franchise_class_months_service_role_all
  on public.fitness_franchise_class_months
  for all
  using (false)
  with check (false);

drop policy if exists fitness_co_brand_partnerships_service_role_all
  on public.fitness_co_brand_partnerships;
create policy fitness_co_brand_partnerships_service_role_all
  on public.fitness_co_brand_partnerships
  for all
  using (false)
  with check (false);

drop policy if exists fitness_algorithm_policies_service_role_all
  on public.fitness_algorithm_policies;
create policy fitness_algorithm_policies_service_role_all
  on public.fitness_algorithm_policies
  for all
  using (false)
  with check (false);

drop policy if exists fitness_cocreation_modules_service_role_all
  on public.fitness_cocreation_modules;
create policy fitness_cocreation_modules_service_role_all
  on public.fitness_cocreation_modules
  for all
  using (false)
  with check (false);

drop policy if exists fitness_realization_applications_service_role_all
  on public.fitness_realization_applications;
create policy fitness_realization_applications_service_role_all
  on public.fitness_realization_applications
  for all
  using (false)
  with check (false);

drop policy if exists fitness_trainer_royalty_applications_service_role_all
  on public.fitness_trainer_royalty_applications;
create policy fitness_trainer_royalty_applications_service_role_all
  on public.fitness_trainer_royalty_applications
  for all
  using (false)
  with check (false);

drop policy if exists fitness_live_residual_applications_service_role_all
  on public.fitness_live_residual_applications;
create policy fitness_live_residual_applications_service_role_all
  on public.fitness_live_residual_applications
  for all
  using (false)
  with check (false);

drop policy if exists fitness_franchise_applications_service_role_all
  on public.fitness_franchise_applications;
create policy fitness_franchise_applications_service_role_all
  on public.fitness_franchise_applications
  for all
  using (false)
  with check (false);

drop policy if exists fitness_cobrand_split_applications_service_role_all
  on public.fitness_cobrand_split_applications;
create policy fitness_cobrand_split_applications_service_role_all
  on public.fitness_cobrand_split_applications
  for all
  using (false)
  with check (false);

drop policy if exists fitness_algorithm_royalty_ledger_service_role_all
  on public.fitness_algorithm_royalty_ledger;
create policy fitness_algorithm_royalty_ledger_service_role_all
  on public.fitness_algorithm_royalty_ledger
  for all
  using (false)
  with check (false);

drop policy if exists fitness_cocreation_applications_service_role_all
  on public.fitness_cocreation_applications;
create policy fitness_cocreation_applications_service_role_all
  on public.fitness_cocreation_applications
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.fitness_trainer_tier_schedules to service_role;
grant select, insert, update, delete on public.fitness_completion_months to service_role;
grant select, insert, update, delete on public.fitness_sync_music_policies to service_role;
grant select, insert, update, delete on public.fitness_live_load_policies to service_role;
grant select, insert, update, delete on public.fitness_franchise_policies to service_role;
grant select, insert, update, delete on public.fitness_franchise_class_months to service_role;
grant select, insert, update, delete on public.fitness_co_brand_partnerships to service_role;
grant select, insert, update, delete on public.fitness_algorithm_policies to service_role;
grant select, insert, update, delete on public.fitness_cocreation_modules to service_role;
grant select, insert, update, delete on public.fitness_realization_applications to service_role;
grant select, insert, update, delete on public.fitness_trainer_royalty_applications to service_role;
grant select, insert, update, delete on public.fitness_live_residual_applications to service_role;
grant select, insert, update, delete on public.fitness_franchise_applications to service_role;
grant select, insert, update, delete on public.fitness_cobrand_split_applications to service_role;
grant select, insert, update, delete on public.fitness_algorithm_royalty_ledger to service_role;
grant select, insert, update, delete on public.fitness_cocreation_applications to service_role;

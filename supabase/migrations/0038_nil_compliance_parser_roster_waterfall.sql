-- =============================================================================
-- 0038 — The NIL lane: the compliance parser + roster waterfall's durable
-- facts of record (PR 34)
--
-- The founder's NIL directive's tables, per the brief:
--
--   nil_revenue_share_programs      <- upsertNilRevenueShareProgram /
--                                      getNilRevenueShareProgram
--     (the adjusted direct revenue-sharing program of record per scope
--      ('school:<uuid>' | 'collective:<uuid>'): the roster Title IX
--      allocation reserve (bps of the gross pool) and the school
--      administrative fee (bps). UNIQUE per scope_key: an upsert
--      converges — the newest rates govern the next pool walk.)
--
--   nil_roster_waterfalls           <- upsertNilRosterWaterfall /
--                                      getNilRosterWaterfall
--     (the tiered roster waterfall config of record per (scope_key,
--      waterfall_key): kind 'position' or 'performance', and the tier
--      schedule JSON (share tiers priced off the NET pool, stipend tiers
--      capped at the remaining pool). UNIQUE per (scope_key,
--      waterfall_key): an upsert converges. Configurable per school or
--      collective — the directive's example: starting QB 15%, O-line pool
--      25%, walk-on base stipend tier.)
--
--   nil_school_caps                 <- upsertNilSchoolCap /
--                                      getNilSchoolCap
--     (the institutional cap allowance of record per (school_id, cap_year):
--      the annual revenue-share cap — e.g. $20.5M. UNIQUE per (school_id,
--      cap_year): an upsert converges.)
--
--   nil_cap_verifications           <- insertNilCapVerification /
--                                      getNilCapVerification
--     (the verified cap verification of record per (school_id, cap_year) —
--      the associated-entity holdback's release key. UNIQUE per (school_id,
--      cap_year): insert-as-lock, the FIRST verification wins; a
--      concurrent second insert surfaces the conflict. The payout reads
--      this row FAIL-CLOSED — no verification of record, collective/
--      booster-backed money holds.)
--
--   nil_deal_compliance_audits      <- upsertNilDealComplianceAudit /
--                                      getNilDealComplianceAudit
--     (the valid business purpose audit of record per nil_contract_id:
--      deals at or above $600 flag for mandatory compliance metadata
--      matching ('flagged'); the matched metadata (purpose description +
--      evidence) clears it ('nil_cleared'). UNIQUE per nil_contract_id:
--      an upsert converges — a clear heals 'flagged'; never the reverse
--      through this table.)
--
--   nil_payout_applications         <- insertNilPayoutApplication
--     (the append-only per-event deal payout application — the deal
--      money's commit. UNIQUE per source_event_id is the replay guard (a
--      re-walked event pays once, never twice). The verdict records the
--      payout gate's outcome: 'paid' (every gate passed),
--      'held_compliance' (the valid business purpose audit), or
--      'held_state_rule' (the state matrix block) — held money is
--      visible, never dropped, never posted.)
--
--   nil_pool_applications           <- insertNilPoolApplication
--     (the append-only per-event pool application — the adjusted
--      calculator's pool math and the tiered roster walk's committed
--      slices. UNIQUE per source_event_id is the replay guard. The
--      conservation identity is pinned in a CHECK: title_ix_reserve +
--      admin_fee + net_athlete_share_pool = gross_pool, ALWAYS.)
--
--   nil_group_splits                <- insertNilGroupSplit
--     (the group NIL equal split of record per media-rights distribution:
--      the team-wide video game / apparel / media license revenue divides
--      equally across all participating roster members — floor per
--      member, the odd-cent residue sweeps to dust. UNIQUE per
--      source_event_id is the replay guard. The conservation identity is
--      pinned in a CHECK: per_participant × participant_count + dust =
--      total, ALWAYS.)
--
--   nil_state_rules                 <- upsertNilStateRule /
--                                      listNilStateRules
--     (the high school state compliance matrix's rule of record per
--      (state_jurisdiction_code, rule_code): the enforcement vocabulary
--      ('prohibited' | 'permitted' | 'conditional'), the deal category
--      the rule covers, and the rule's summary. UNIQUE per (state,
--      rule_code): an upsert converges — the newest rule governs the next
--      payout execution. Enforced BEFORE contract payout execution — a
--      'prohibited' rule blocks; 'conditional' blocks without the rule's
--      summary satisfied in the audit trail (fail-closed).)
--
--   nil_payout_gate_states          <- upsertNilPayoutGateState /
--                                      getNilPayoutGateState
--     (the durable NIL payout gate states of record per (payee_id,
--      school_id): nil_clearance_state, compliance_state, title_ix_state,
--      institutional_cap_state, and the associated-entity backing flag —
--      the payout compliance gate reads ALL of them fail-closed: an
--      ABSENT row resolves null and an 'unknown' state refuses. An upsert
--      converges: a verification heals 'unknown'; states never regress
--      through this table.)
--
-- No foreign keys by design: the ten tables key on the addendum 13
-- identifier space (athlete_id, school_id, state_jurisdiction_code), the
-- sender's NIL contract ids, and content-derived event ids — the same
-- discipline 0036/0037 applied (ledger transaction ids and match_queue
-- carry no FK either).
--
-- The constraint discipline (the 0032 production lesson, applied): every
-- CHECK is a TABLE-level constraint with an explicit, table-namespaced name
-- (ck_ prefix); no column-level constraint ever shares a name with a
-- table-level one. UNIQUE constraints stay inline and unnamed (the 0032
-- pattern) — Postgres auto-names them off the table and columns, which
-- cannot collide with the explicit ck_ names.
--
-- The money discipline: pools, pools' deductions, fees, and splits are
-- non-negative bigints with their conservation identities pinned in
-- CHECKs; a pool or split outside its identity cannot persist. The
-- $600 flag threshold lives in application code (the records module's
-- NIL_BUSINESS_PURPOSE_THRESHOLD_CENTS) — the audit row records the deal
-- value it flagged.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with the 0033 service-role grant set (the 0017–0037
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- nil_revenue_share_programs: the adjusted direct revenue-sharing program
-- of record per scope — the Title IX reserve and the admin fee, bps.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_revenue_share_programs (
  id                  uuid primary key default gen_random_uuid(),
  scope_key           text not null,
  scope               text not null,
  school_id           text,
  collective_id       text,
  title_ix_reserve_bps integer not null,
  admin_fee_bps       integer not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (scope_key),
  constraint ck_nil_revenue_share_programs_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_nil_revenue_share_programs_scope_vocab
    check (scope in ('school', 'collective')),
  constraint ck_nil_revenue_share_programs_scope_identity
    check (
      (scope = 'school' and school_id is not null and collective_id is null)
      or (scope = 'collective' and collective_id is not null and school_id is null)
    ),
  constraint ck_nil_revenue_share_programs_rates_band
    check (
      title_ix_reserve_bps >= 0 and title_ix_reserve_bps <= 10000
      and admin_fee_bps >= 0 and admin_fee_bps <= 10000
    )
);

comment on table public.nil_revenue_share_programs is
  'The adjusted direct revenue-sharing program of record (migration 0038) per scope (school:<uuid> | collective:<uuid>): the roster Title IX allocation reserve and the school administrative fee, bps of the gross pool. UNIQUE (scope_key): an upsert converges — the newest rates govern the next pool walk. The calculator is application code: Net Athlete Share Pool = gross − title_ix − admin_fee (each floor-derived off the GROSS), conserved by the pool application''s CHECK.';

-- ---------------------------------------------------------------------------
-- nil_roster_waterfalls: the tiered roster waterfall config of record per
-- (scope, key) — position or performance tiers.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_roster_waterfalls (
  id            uuid primary key default gen_random_uuid(),
  scope_key     text not null,
  waterfall_key text not null,
  kind          text not null,
  tiers         jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (scope_key, waterfall_key),
  constraint ck_nil_roster_waterfalls_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_nil_roster_waterfalls_key_present
    check (char_length(waterfall_key) > 0),
  constraint ck_nil_roster_waterfalls_kind
    check (kind in ('position', 'performance'))
);

comment on table public.nil_roster_waterfalls is
  'The tiered roster waterfall config of record (migration 0038) per (scope, key): kind ''position'' or ''performance'', and the tier schedule JSON — share tiers priced off the NET pool, stipend tiers capped at the remaining pool. UNIQUE (scope_key, waterfall_key): an upsert converges. Configurable per school or collective (e.g. starting QB 15%, O-line pool 25%, walk-on base stipend tier). The schedule is validated by the records module before it ever reaches this seam.';

-- ---------------------------------------------------------------------------
-- nil_school_caps: the institutional cap allowance of record per
-- (school, year) — the annual revenue-share cap.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_school_caps (
  id               uuid primary key default gen_random_uuid(),
  school_id        text not null,
  cap_year         text not null,
  annual_cap_cents bigint not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (school_id, cap_year),
  constraint ck_nil_school_caps_school_present
    check (char_length(school_id) > 0),
  constraint ck_nil_school_caps_year_shape
    check (cap_year ~ '^[0-9]{4}$'),
  constraint ck_nil_school_caps_cap_positive
    check (annual_cap_cents > 0)
);

comment on table public.nil_school_caps is
  'The institutional cap allowance of record (migration 0038) per (school, year): the annual revenue-share cap (e.g. $20.5M = 2050000000 cents). UNIQUE (school_id, cap_year): an upsert converges. The associated-entity holdback verifies against this allowance before collective/booster-backed money pays.';

-- ---------------------------------------------------------------------------
-- nil_cap_verifications: the verified cap verification of record — the
-- associated-entity holdback's release key, insert-as-lock per (school,
-- year).
-- ---------------------------------------------------------------------------
create table if not exists public.nil_cap_verifications (
  id                       uuid primary key default gen_random_uuid(),
  school_id                text not null,
  cap_year                 text not null,
  verified_committed_cents bigint not null,
  evidence_ref             text not null,
  verified_by              text not null,
  created_at               timestamptz not null default now(),
  unique (school_id, cap_year),
  constraint ck_nil_cap_verifications_school_present
    check (char_length(school_id) > 0),
  constraint ck_nil_cap_verifications_year_shape
    check (cap_year ~ '^[0-9]{4}$'),
  constraint ck_nil_cap_verifications_committed_nonneg
    check (verified_committed_cents >= 0),
  constraint ck_nil_cap_verifications_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_nil_cap_verifications_verifier_present
    check (char_length(verified_by) > 0)
);

comment on table public.nil_cap_verifications is
  'The verified cap verification of record (migration 0038) per (school, year) — the associated-entity holdback''s release key. UNIQUE (school_id, cap_year): insert-as-lock, the FIRST verification wins; a concurrent second insert surfaces the conflict. The payout reads this row FAIL-CLOSED — no verification of record, collective/booster-backed money holds.';

-- ---------------------------------------------------------------------------
-- nil_deal_compliance_audits: the valid business purpose audit of record
-- per NIL contract — the $600 flag and the nil_cleared state.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_deal_compliance_audits (
  id                     uuid primary key default gen_random_uuid(),
  nil_contract_id        text not null,
  athlete_id             text not null,
  school_id              text not null,
  deal_value_cents       bigint not null,
  business_purpose_state text not null,
  purpose_description    text,
  evidence_ref           text,
  cleared_by             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (nil_contract_id),
  constraint ck_nil_deal_compliance_audits_contract_present
    check (char_length(nil_contract_id) > 0),
  constraint ck_nil_deal_compliance_audits_athlete_present
    check (char_length(athlete_id) > 0),
  constraint ck_nil_deal_compliance_audits_school_present
    check (char_length(school_id) > 0),
  constraint ck_nil_deal_compliance_audits_value_nonneg
    check (deal_value_cents >= 0),
  constraint ck_nil_deal_compliance_audits_state_vocab
    check (business_purpose_state in ('flagged', 'nil_cleared')),
  constraint ck_nil_deal_compliance_audits_cleared_shape
    check (
      (business_purpose_state = 'nil_cleared'
       and purpose_description is not null
       and evidence_ref is not null
       and cleared_by is not null)
      or (business_purpose_state = 'flagged')
    )
);

comment on table public.nil_deal_compliance_audits is
  'The valid business purpose audit of record (migration 0038) per NIL contract: deals at or above $600 flag for mandatory compliance metadata matching (''flagged''); the matched metadata (purpose description + evidence + clearer) heals the row to ''nil_cleared''. UNIQUE (nil_contract_id): an upsert converges — a clear heals ''flagged''; never the reverse through this table. Below the threshold the lane records no audit row and pays through.';

-- ---------------------------------------------------------------------------
-- nil_payout_applications: the append-only per-event deal payout
-- application — the deal money's commit, verdict-gated.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_payout_applications (
  id                 uuid primary key default gen_random_uuid(),
  nil_contract_id    text not null,
  athlete_id         text not null,
  school_id          text not null,
  source_event_id    text not null,
  period             text not null,
  gross_cents        bigint not null,
  agency_mode        text not null,
  agency_bps         integer not null,
  agency_fee_cents   bigint not null,
  net_payout_cents   bigint not null,
  verdict            text not null,
  state_rule_ref     text,
  cap_verified_ref   text,
  created_at         timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_nil_payout_applications_contract_present
    check (char_length(nil_contract_id) > 0),
  constraint ck_nil_payout_applications_athlete_present
    check (char_length(athlete_id) > 0),
  constraint ck_nil_payout_applications_school_present
    check (char_length(school_id) > 0),
  constraint ck_nil_payout_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_nil_payout_applications_period_shape
    check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint ck_nil_payout_applications_amounts_nonneg
    check (gross_cents >= 0 and agency_fee_cents >= 0 and net_payout_cents >= 0),
  constraint ck_nil_payout_applications_agency_mode
    check (agency_mode in ('marketing', 'direct_rev_share', 'none')),
  constraint ck_nil_payout_applications_agency_band
    check (
      (agency_mode = 'marketing' and agency_bps between 1000 and 2000)
      or (agency_mode = 'direct_rev_share' and agency_bps between 300 and 500)
      or (agency_mode = 'none' and agency_bps = 0)
    ),
  constraint ck_nil_payout_applications_verdict_vocab
    check (verdict in ('paid', 'held_compliance', 'held_state_rule')),
  constraint ck_nil_payout_applications_conserves
    check (net_payout_cents = gross_cents - agency_fee_cents)
);

comment on table public.nil_payout_applications is
  'The append-only per-event deal payout application (migration 0038) — the deal money''s commit. UNIQUE (source_event_id) is the replay guard: a re-walked event pays once, never twice. The verdict records the payout gate''s outcome: ''paid'' (every gate passed), ''held_compliance'' (the valid business purpose audit), or ''held_state_rule'' (the state matrix block) — held money is visible, never dropped, never posted. The agency commission is deducted AT PAYOUT (10–20% marketing, 3–5% direct rev-share, 0 for none) and the conservation identity net = gross − fee is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- nil_pool_applications: the append-only per-event pool application — the
-- adjusted calculator's pool math and the roster walk's committed slices.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_pool_applications (
  id                          uuid primary key default gen_random_uuid(),
  school_id                   text not null,
  pool_type                   text not null,
  source_event_id             text not null,
  period                      text not null,
  gross_pool_cents            bigint not null,
  title_ix_reserve_bps        integer not null,
  title_ix_reserve_cents      bigint not null,
  admin_fee_bps               integer not null,
  admin_fee_cents             bigint not null,
  net_athlete_share_pool_cents bigint not null,
  waterfall_key               text not null,
  tier_kind                   text not null,
  slices                      jsonb not null,
  roster_paid_cents           bigint not null,
  dust_cents                  bigint not null,
  created_at                  timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_nil_pool_applications_school_present
    check (char_length(school_id) > 0),
  constraint ck_nil_pool_applications_pool_type
    check (pool_type in ('media_rights', 'ticket_distribution')),
  constraint ck_nil_pool_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_nil_pool_applications_period_shape
    check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint ck_nil_pool_applications_amounts_nonneg
    check (
      gross_pool_cents >= 0
      and title_ix_reserve_cents >= 0
      and admin_fee_cents >= 0
      and net_athlete_share_pool_cents >= 0
      and roster_paid_cents >= 0
      and dust_cents >= 0
    ),
  constraint ck_nil_pool_applications_rates_band
    check (
      title_ix_reserve_bps >= 0 and title_ix_reserve_bps <= 10000
      and admin_fee_bps >= 0 and admin_fee_bps <= 10000
    ),
  constraint ck_nil_pool_applications_tier_kind
    check (tier_kind in ('position', 'performance')),
  constraint ck_nil_pool_applications_pool_conserves
    check (
      title_ix_reserve_cents + admin_fee_cents + net_athlete_share_pool_cents
      = gross_pool_cents
    ),
  constraint ck_nil_pool_applications_roster_conserves
    check (roster_paid_cents + dust_cents = net_athlete_share_pool_cents)
);

comment on table public.nil_pool_applications is
  'The append-only per-event pool application (migration 0038) — the adjusted direct revenue-sharing calculator''s pool math plus the tiered roster walk''s committed slices. UNIQUE (source_event_id) is the replay guard. The conservation identities are pinned in CHECKs: title_ix + admin_fee + net = gross_pool ALWAYS, and roster_paid + dust = net ALWAYS — a pool walk that loses a cent cannot persist.';

-- ---------------------------------------------------------------------------
-- nil_group_splits: the group NIL equal split of record per media-rights
-- distribution — floor per member, the residue sweeps to dust.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_group_splits (
  id                    uuid primary key default gen_random_uuid(),
  scope_ref             text not null,
  rights_stream         text not null,
  source_event_id       text not null,
  period                text not null,
  total_cents           bigint not null,
  participant_ids       jsonb not null,
  participant_count     integer not null,
  per_participant_cents bigint not null,
  dust_cents            bigint not null,
  created_at            timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_nil_group_splits_scope_present
    check (char_length(scope_ref) > 0),
  constraint ck_nil_group_splits_rights_stream
    check (rights_stream in ('video_game', 'apparel', 'media')),
  constraint ck_nil_group_splits_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_nil_group_splits_period_shape
    check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint ck_nil_group_splits_amounts_nonneg
    check (
      total_cents >= 0
      and per_participant_cents >= 0
      and dust_cents >= 0
      and participant_count > 0
    ),
  constraint ck_nil_group_splits_count_consistent
    check (
      participant_count = jsonb_array_length(participant_ids)
    ),
  constraint ck_nil_group_splits_conserves
    check (
      per_participant_cents * participant_count + dust_cents = total_cents
    )
);

comment on table public.nil_group_splits is
  'The group NIL equal split of record (migration 0038) per media-rights distribution: team-wide video game / apparel / media license revenue divides EQUALLY across all participating roster members — floor per member, the odd-cent residue sweeps to dust. UNIQUE (source_event_id) is the replay guard. The conservation identity per_participant × count + dust = total is pinned in a CHECK, and the roster JSON''s length must equal participant_count.';

-- ---------------------------------------------------------------------------
-- nil_state_rules: the high school state compliance matrix's rule of
-- record per (state, rule) — enforced BEFORE payout execution.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_state_rules (
  id                      uuid primary key default gen_random_uuid(),
  state_jurisdiction_code text not null,
  rule_code               text not null,
  applies_to_category     text not null,
  enforcement             text not null,
  rule_summary            text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (state_jurisdiction_code, rule_code),
  constraint ck_nil_state_rules_state_shape
    check (state_jurisdiction_code ~ '^[A-Z]{2}$'),
  constraint ck_nil_state_rules_code_present
    check (char_length(rule_code) > 0),
  constraint ck_nil_state_rules_category_present
    check (char_length(applies_to_category) > 0),
  constraint ck_nil_state_rules_enforcement_vocab
    check (enforcement in ('prohibited', 'permitted', 'conditional')),
  constraint ck_nil_state_rules_summary_present
    check (char_length(rule_summary) > 0)
);

comment on table public.nil_state_rules is
  'The high school state compliance matrix''s rule of record (migration 0038) per (state, rule_code): the enforcement vocabulary (''prohibited'' | ''permitted'' | ''conditional''), the deal category the rule covers, and the rule''s summary (e.g. prohibitions on wearing high school team jerseys in private brand endorsements). UNIQUE (state, rule_code): an upsert converges — the newest rule governs the next payout execution. Enforced BEFORE contract payout execution: ''prohibited'' blocks; ''conditional'' blocks without the rule satisfied in the audit trail; an ABSENT rule reads fail-closed as unverified for gated categories.';

-- ---------------------------------------------------------------------------
-- nil_payout_gate_states: the durable NIL payout gate states of record —
-- nil_cleared + verified + title_ix_cleared + cap_verified, fail-closed.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_payout_gate_states (
  id                             uuid primary key default gen_random_uuid(),
  payee_id                       text not null,
  school_id                      text not null,
  nil_clearance_state            text not null,
  compliance_state               text not null,
  title_ix_state                 text not null,
  collective_or_booster_backed   boolean,
  institutional_cap_state        text not null,
  evidence_ref                   text,
  verified_by                    text,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  unique (payee_id, school_id),
  constraint ck_nil_payout_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_nil_payout_gate_states_school_present
    check (char_length(school_id) > 0),
  constraint ck_nil_payout_gate_states_nil_state
    check (nil_clearance_state in ('unknown', 'nil_cleared')),
  constraint ck_nil_payout_gate_states_compliance_state
    check (compliance_state in ('unknown', 'verified')),
  constraint ck_nil_payout_gate_states_title_ix_state
    check (title_ix_state in ('unknown', 'cleared')),
  constraint ck_nil_payout_gate_states_cap_state
    check (institutional_cap_state in ('unknown', 'verified'))
);

comment on table public.nil_payout_gate_states is
  'The durable NIL payout gate states of record (migration 0038) per (payee, school): nil_clearance_state (''unknown'' | ''nil_cleared''), compliance_state (''unknown'' | ''verified''), title_ix_state (''unknown'' | ''cleared''), the associated-entity backing flag (true collective/booster-backed, false a direct deal, null UNKNOWN — the fail-closed reading), and institutional_cap_state (''unknown'' | ''verified''), with evidence and verifier provenance when set. The payout gate reads ALL of them fail-closed: an ABSENT row resolves null and an ''unknown'' state refuses. An upsert converges: a verification heals ''unknown''; states never regress through this table.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all for client roles (the 0017–0037 precedent) — explicit
-- policies so the denial is auditable, not an accident of missing grants.
-- ---------------------------------------------------------------------------
alter table public.nil_revenue_share_programs enable row level security;
alter table public.nil_roster_waterfalls enable row level security;
alter table public.nil_school_caps enable row level security;
alter table public.nil_cap_verifications enable row level security;
alter table public.nil_deal_compliance_audits enable row level security;
alter table public.nil_payout_applications enable row level security;
alter table public.nil_pool_applications enable row level security;
alter table public.nil_group_splits enable row level security;
alter table public.nil_state_rules enable row level security;
alter table public.nil_payout_gate_states enable row level security;

drop policy if exists nil_revenue_share_programs_service_role_all
  on public.nil_revenue_share_programs;
create policy nil_revenue_share_programs_service_role_all
  on public.nil_revenue_share_programs
  for all
  using (false)
  with check (false);

drop policy if exists nil_roster_waterfalls_service_role_all
  on public.nil_roster_waterfalls;
create policy nil_roster_waterfalls_service_role_all
  on public.nil_roster_waterfalls
  for all
  using (false)
  with check (false);

drop policy if exists nil_school_caps_service_role_all
  on public.nil_school_caps;
create policy nil_school_caps_service_role_all
  on public.nil_school_caps
  for all
  using (false)
  with check (false);

drop policy if exists nil_cap_verifications_service_role_all
  on public.nil_cap_verifications;
create policy nil_cap_verifications_service_role_all
  on public.nil_cap_verifications
  for all
  using (false)
  with check (false);

drop policy if exists nil_deal_compliance_audits_service_role_all
  on public.nil_deal_compliance_audits;
create policy nil_deal_compliance_audits_service_role_all
  on public.nil_deal_compliance_audits
  for all
  using (false)
  with check (false);

drop policy if exists nil_payout_applications_service_role_all
  on public.nil_payout_applications;
create policy nil_payout_applications_service_role_all
  on public.nil_payout_applications
  for all
  using (false)
  with check (false);

drop policy if exists nil_pool_applications_service_role_all
  on public.nil_pool_applications;
create policy nil_pool_applications_service_role_all
  on public.nil_pool_applications
  for all
  using (false)
  with check (false);

drop policy if exists nil_group_splits_service_role_all
  on public.nil_group_splits;
create policy nil_group_splits_service_role_all
  on public.nil_group_splits
  for all
  using (false)
  with check (false);

drop policy if exists nil_state_rules_service_role_all
  on public.nil_state_rules;
create policy nil_state_rules_service_role_all
  on public.nil_state_rules
  for all
  using (false)
  with check (false);

drop policy if exists nil_payout_gate_states_service_role_all
  on public.nil_payout_gate_states;
create policy nil_payout_gate_states_service_role_all
  on public.nil_payout_gate_states
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.nil_revenue_share_programs to service_role;
grant select, insert, update, delete on public.nil_roster_waterfalls to service_role;
grant select, insert, update, delete on public.nil_school_caps to service_role;
grant select, insert, update, delete on public.nil_cap_verifications to service_role;
grant select, insert, update, delete on public.nil_deal_compliance_audits to service_role;
grant select, insert, update, delete on public.nil_payout_applications to service_role;
grant select, insert, update, delete on public.nil_pool_applications to service_role;
grant select, insert, update, delete on public.nil_group_splits to service_role;
grant select, insert, update, delete on public.nil_state_rules to service_role;
grant select, insert, update, delete on public.nil_payout_gate_states to service_role;

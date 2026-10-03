-- =============================================================================
-- 0033 — Estate succession + multi-heir splitting: verified legal
-- certificates, probate schedules, receiving-entity transitions, split
-- accruals, and payout-gate states (PR 29)
--
-- The estate payout protections' durable facts of record, per the founder
-- directive: when an artist passes away, the Don Ledger's receiving entity
-- transitions to the verified estate entity upon legal certificate
-- validation, and incoming licensing and resale funds divide according to
-- the VERIFIED probate percentages before the standing release machinery
-- disburses them.
--
--   estate_succession_certificates <- verifyEstateSuccessionCertificate /
--                                      getEstateSuccessionCertificate(+ById)
--     (the verified legal fact the whole lane gates on, per
--      (artist_payee_id, certificate_ref). certificate_hash is the
--      certificate document's SHA-256 hex digest — the audit anchor.
--      validation_state is the fail-closed vocabulary: ONLY 'verified'
--      transitions; absent, 'pending', and 'rejected' all refuse. The
--      consistency check pins verified_by/verified_at to the verified
--      state — a verified row without its operator stamp cannot rest.)
--   estate_heir_schedules          <- registerEstateHeirSchedule /
--                                      getEstateHeirSchedule
--     (the probate split schedule of record per certificate —
--      CONFIGURABLE per probate (e.g. spouse 50% / child A 25% /
--      child B 25%). heirs is the jsonb roster of EstateHeirSpec rows
--      (whole basis points; read whole — the 0030 contributors
--      discipline). UNIQUE per certificate_id: a re-registration (a
--      probate amendment) replaces the row atomically and increments
--      version; accrued splits keep their version's history — never
--      re-cut.)
--   estate_succession_transitions  <- insertEstateSuccessionTransition /
--                                      listEstateSuccessionTransitions
--     (the append-only receiving-entity handoff ledger. UNIQUE per
--      (certificate_id, source_event_id): a replayed transition is the
--      unique violation, never a double handoff. artwork_id and
--      provenance_hash carry the funds' provenance for audit. Rows are
--      inserted and never updated or deleted — the existing ledger
--      history stays intact, audit-preserving.)
--   estate_split_accruals          <- insertEstateSplitAccrual /
--                                      listEstateSplitAccruals
--     (the append-only multi-heir accrual ledger: allocations is the
--      jsonb array of per-heir designated shares ({ heir_payee_id,
--      heir_payee_name, relationship, share_cents }); dust_cents is the
--      sub-cent residue of the percentage cut — conservation:
--      allocations + dust = basis, exact, nothing rounds up into an
--      heir's credit. UNIQUE per (certificate_id, artwork_id,
--      source_event_id) — the provenance triple IS the once-only key: a
--      replayed event is the unique violation, never a double
--      designation. One funding event can cover several artworks, so the
--      triple — not (schedule_id, source_event_id) — is the guard.)
--   estate_payout_gate_states      <- upsertEstatePayoutGateState /
--                                      getEstatePayoutGateState
--     (the per-payee estate succession state of record the art vertical's
--      payout gate reads through resolveArtVerticalComplianceState —
--      fail-closed: absent refuses (vertical_state_unknown), 'unknown'
--      refuses (art_estate_succession_unverified), ONLY 'verified'
--      passes. UNIQUE per payee_id: a re-recording converges — the
--      newest state governs the next dispatch.)
--
-- The constraint discipline (the 0032 production lesson, applied): every
-- CHECK and FK is a TABLE-level constraint with an explicit, table-
-- namespaced name (ck_/fk_ prefixes); no column-level constraint ever
-- shares a name with a table-level one. UNIQUE constraints stay inline and
-- unnamed (the 0032 pattern) — Postgres auto-names them off the table and
-- columns, which cannot collide with the explicit ck_/fk_ names.
--
-- The money discipline: every *_cents column is an integer cent count (the
-- Don ledger's whole-cents contract). Ledger-child tables carry the 0027
-- foreign-key discipline (cascade on delete); the gate-state table is
-- keyed by its natural key (payee_id) with no ledger reference.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with the 0032 service-role grant (the 0017–0032
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- estate_succession_certificates: the verified legal fact of record per
-- (artist_payee_id, certificate_ref).
-- ---------------------------------------------------------------------------
create table if not exists public.estate_succession_certificates (
  id                      uuid primary key default gen_random_uuid(),
  artist_payee_id         text not null,
  certificate_ref         text not null,
  certificate_hash        text not null,
  estate_entity_payee_id  text not null,
  estate_entity_payee_name text not null,
  validation_state        text not null,
  verified_by             text,
  verified_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (artist_payee_id, certificate_ref),
  constraint ck_estate_certificates_validation_state
    check (validation_state in ('pending', 'verified', 'rejected')),
  constraint ck_estate_certificates_hash_shape
    check (certificate_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_estate_certificates_verify_stamp
    check (
      (validation_state = 'verified' and verified_at is not null and verified_by is not null)
      or (validation_state <> 'verified' and verified_at is null and verified_by is null)
    )
);

create index if not exists estate_succession_certificates_artist_idx
  on public.estate_succession_certificates (artist_payee_id);

comment on table public.estate_succession_certificates is
  'The estate succession legal certificate of record per (artist_payee_id, certificate_ref): certificate_hash is the document''s SHA-256 audit anchor. ONLY validation_state = ''verified'' authorizes a receiving-entity transition — absent, pending, and rejected all refuse, fail-closed. The verify-stamp check pins verified_by/verified_at to the verified state.';

-- ---------------------------------------------------------------------------
-- estate_heir_schedules: the probate split schedule of record per
-- certificate — configurable per probate.
-- ---------------------------------------------------------------------------
create table if not exists public.estate_heir_schedules (
  id             uuid primary key default gen_random_uuid(),
  certificate_id uuid not null,
  heirs          jsonb not null,
  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (certificate_id),
  constraint fk_estate_heir_schedules_certificate
    foreign key (certificate_id) references public.estate_succession_certificates (id)
    on delete cascade,
  constraint ck_estate_heir_schedules_version
    check (version >= 1),
  constraint ck_estate_heir_schedules_heirs_shape
    check (jsonb_typeof(heirs) = 'array')
);

comment on table public.estate_heir_schedules is
  'The probate split schedule of record per certificate — configurable per probate (e.g. spouse 50% / child A 25% / child B 25% as whole basis points). heirs is the jsonb roster of EstateHeirSpec rows, read whole. UNIQUE (certificate_id): a re-registration (a probate amendment) replaces the row atomically and increments version; accrued splits keep their version''s history — never re-cut.';

-- ---------------------------------------------------------------------------
-- estate_succession_transitions: the append-only receiving-entity handoff
-- ledger — inserted, never updated or deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.estate_succession_transitions (
  id                      uuid primary key default gen_random_uuid(),
  certificate_id          uuid not null,
  artist_payee_id         text not null,
  estate_entity_payee_id  text not null,
  source_event_id         text not null,
  artwork_id              text,
  provenance_hash         text,
  created_at              timestamptz not null default now(),
  unique (certificate_id, source_event_id),
  constraint fk_estate_transitions_certificate
    foreign key (certificate_id) references public.estate_succession_certificates (id)
    on delete cascade,
  constraint ck_estate_transitions_artist_present
    check (char_length(artist_payee_id) > 0),
  constraint ck_estate_transitions_estate_present
    check (char_length(estate_entity_payee_id) > 0),
  constraint ck_estate_transitions_event_present
    check (char_length(source_event_id) > 0)
);

create index if not exists estate_succession_transitions_certificate_idx
  on public.estate_succession_transitions (certificate_id);
create index if not exists estate_succession_transitions_artwork_idx
  on public.estate_succession_transitions (artwork_id);

comment on table public.estate_succession_transitions is
  'The append-only receiving-entity handoff ledger: one row per (certificate, driving funding event). UNIQUE (certificate_id, source_event_id) is the replay guard — the unique violation IS the once-only signal, never a double handoff. artwork_id and provenance_hash carry the funds'' provenance for audit. Rows are inserted and never updated or deleted — audit-preserving.';

-- ---------------------------------------------------------------------------
-- estate_split_accruals: the append-only multi-heir accrual ledger — the
-- once-only designation behind the payout gates.
-- ---------------------------------------------------------------------------
create table if not exists public.estate_split_accruals (
  id                      uuid primary key default gen_random_uuid(),
  schedule_id             uuid not null,
  certificate_id          uuid not null,
  artist_payee_id         text not null,
  estate_entity_payee_id  text not null,
  source_event_id         text not null,
  artwork_id              text not null,
  provenance_hash         text not null,
  basis_cents             integer not null,
  allocations             jsonb not null,
  dust_cents              integer not null default 0,
  created_at              timestamptz not null default now(),
  unique (certificate_id, artwork_id, source_event_id),
  constraint fk_estate_accruals_schedule
    foreign key (schedule_id) references public.estate_heir_schedules (id)
    on delete cascade,
  constraint fk_estate_accruals_certificate
    foreign key (certificate_id) references public.estate_succession_certificates (id)
    on delete cascade,
  constraint ck_estate_accruals_basis
    check (basis_cents >= 0),
  constraint ck_estate_accruals_dust
    check (dust_cents >= 0),
  constraint ck_estate_accruals_allocations_shape
    check (jsonb_typeof(allocations) = 'array'),
  constraint ck_estate_accruals_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_estate_accruals_artwork_present
    check (char_length(artwork_id) > 0)
);

create index if not exists estate_split_accruals_certificate_idx
  on public.estate_split_accruals (certificate_id);
create index if not exists estate_split_accruals_artwork_idx
  on public.estate_split_accruals (artwork_id);

comment on table public.estate_split_accruals is
  'The append-only multi-heir probate accrual ledger: allocations is the jsonb array of per-heir designated shares, dust_cents the sub-cent residue — conservation: allocations + dust = basis, exact, nothing rounds up into an heir''s credit (the dust routes to the platform variance payee, never an heir). UNIQUE (certificate_id, artwork_id, source_event_id) — the provenance triple IS the once-only key: a replayed event is the unique violation, never a double designation. One funding event can cover several artworks, so the triple — not (schedule_id, source_event_id) — is the guard.';

-- ---------------------------------------------------------------------------
-- estate_payout_gate_states: the per-payee estate succession state of
-- record the art vertical's payout gate reads — fail-closed.
-- ---------------------------------------------------------------------------
create table if not exists public.estate_payout_gate_states (
  id                      uuid primary key default gen_random_uuid(),
  payee_id                text not null,
  estate_succession_state text not null,
  certificate_ref         text,
  verified_by             text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (payee_id),
  constraint ck_estate_gate_states_state
    check (estate_succession_state in ('unknown', 'verified'))
);

comment on table public.estate_payout_gate_states is
  'The per-payee estate succession payout-gate state of record the art vertical resolves through (migration 0033). Fail-closed: absent refuses (vertical_state_unknown), ''unknown'' refuses (art_estate_succession_unverified), ONLY ''verified'' passes. UNIQUE (payee_id): a re-recording converges — the newest state governs the next dispatch.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all for client roles (the 0017–0032 precedent) — explicit
-- policies so the denial is auditable, not an accident of missing grants.
-- ---------------------------------------------------------------------------
alter table public.estate_succession_certificates enable row level security;
alter table public.estate_heir_schedules enable row level security;
alter table public.estate_succession_transitions enable row level security;
alter table public.estate_split_accruals enable row level security;
alter table public.estate_payout_gate_states enable row level security;

drop policy if exists estate_succession_certificates_service_role_all
  on public.estate_succession_certificates;
create policy estate_succession_certificates_service_role_all
  on public.estate_succession_certificates
  for all
  using (false)
  with check (false);

drop policy if exists estate_heir_schedules_service_role_all
  on public.estate_heir_schedules;
create policy estate_heir_schedules_service_role_all
  on public.estate_heir_schedules
  for all
  using (false)
  with check (false);

drop policy if exists estate_succession_transitions_service_role_all
  on public.estate_succession_transitions;
create policy estate_succession_transitions_service_role_all
  on public.estate_succession_transitions
  for all
  using (false)
  with check (false);

drop policy if exists estate_split_accruals_service_role_all
  on public.estate_split_accruals;
create policy estate_split_accruals_service_role_all
  on public.estate_split_accruals
  for all
  using (false)
  with check (false);

drop policy if exists estate_payout_gate_states_service_role_all
  on public.estate_payout_gate_states;
create policy estate_payout_gate_states_service_role_all
  on public.estate_payout_gate_states
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.estate_succession_certificates to service_role;
grant select, insert, update, delete on public.estate_heir_schedules to service_role;
grant select, insert, update, delete on public.estate_succession_transitions to service_role;
grant select, insert, update, delete on public.estate_split_accruals to service_role;
grant select, insert, update, delete on public.estate_payout_gate_states to service_role;

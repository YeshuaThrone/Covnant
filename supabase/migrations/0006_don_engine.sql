-- ============================================================================
-- Covnant — The Don Engine (migration 0006)
-- PostgreSQL translation of the canonical Don store schema (Cursor's
-- src/lib/server/store.ts, SCHEMA const) plus the legacy ATXLive surface
-- (shows, live_pings, artists, checkout_sessions) the canonical Store
-- interface carries. The canonical schema is authoritative over any
-- inferred shape (spec art_zxsnGP3A).
--
-- Translation rules (SQLite → PostgreSQL):
--   TEXT ids            → text (the app layer generates ids; no uuid PKs)
--   INTEGER cents       → bigint — integer cents everywhere (repo discipline)
--   INTEGER counters    → integer (sequence, share_bps, tax_year, quantity,
--                         line_item_count)
--   INTEGER 0/1 flags   → integer with a (0,1) check — the record types type
--                         these as `number`, so the store round-trips them
--                         without conversion
--   REAL                → double precision (geo + native ticket price)
--   timestamps          → timestamptz (repo convention; PostgREST surfaces
--                         ISO strings, matching the record types)
--   *_json payloads     → text — the record types carry the serialized JSON
--                         string (splits_json, identity_json, payload_json),
--                         so text keeps store round-trips byte-honest
--   SQLite rowid        → insertion_order bigint generated always as identity
--                         on the tables whose canonical list methods break
--                         created_at ties by insertion order
--
-- Every statement is idempotent (if not exists / or replace): the migration
-- can be re-applied to a scratch database without error.
--
-- Authorization mirrors migrations 0001–0005: RLS is enabled with NO
-- policies (deny-all default) and the service role — the only role the
-- engine's store uses — bypasses RLS and gets full DML grants. The Supabase
-- store's ids are generated application-side, so no database defaults are
-- needed beyond the canonical column defaults.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Legacy ATXLive surface — shows, live pings, artist API keys, checkout
-- capacity accounting. Carried by the canonical Store interface.
-- ---------------------------------------------------------------------------

create table if not exists public.shows (
  id                    text primary key,
  artist_id             text not null,
  artist_name           text not null,
  venue_name            text not null,
  address               text not null default '',
  district              text not null,
  set_time              text not null,
  ticket_url            text not null default '',
  created_at            timestamptz not null,
  ticketing_type        text not null default '',
  native_ticket_price   double precision,
  native_ticket_capacity integer,
  latitude              double precision,
  longitude             double precision,
  council_district      text not null default '',
  insertion_order       bigint generated always as identity
);

create table if not exists public.live_pings (
  id              text primary key,
  artist_id       text not null,
  latitude        double precision not null,
  longitude       double precision not null,
  timestamp       text not null,
  status          text not null,
  insertion_order bigint generated always as identity
);

create table if not exists public.artists (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null,
  key_hash   text not null,
  key_prefix text not null default ''
);

-- PR 24 capacity accounting: one row per completed checkout session. The
-- primary key is the idempotency guard — a repeated success-redirect
-- confirm (or a webhook + redirect race) inserts nothing and therefore
-- never double-decrements capacity.
create table if not exists public.checkout_sessions (
  id         text primary key,
  show_id    text not null,
  quantity   integer not null,
  created_at timestamptz not null
);

-- The canonical recordCheckoutPurchase decrements capacity inside ONE
-- synchronous transaction (idempotent session insert + guarded decrement).
-- SQLite got that for free; PostgreSQL gets it as a function so the
-- Supabase store can keep the exact atomic semantics via rpc.
create or replace function public.record_checkout_purchase(
  p_session_id text,
  p_show_id    text,
  p_quantity   integer
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  show_row  public.shows%rowtype;
  inserted  text;
  remaining integer;
begin
  select * into show_row from public.shows where id = p_show_id;
  if not found
     or show_row.ticketing_type is distinct from 'native'
     or show_row.native_ticket_capacity is null then
    return null;
  end if;

  insert into public.checkout_sessions (id, show_id, quantity, created_at)
  values (p_session_id, p_show_id, p_quantity, now())
  on conflict (id) do nothing
  returning id into inserted;

  if inserted is null then
    select native_ticket_capacity into remaining from public.shows where id = p_show_id;
    return jsonb_build_object('outcome', 'already_recorded', 'remaining', remaining);
  end if;

  update public.shows
  set native_ticket_capacity = native_ticket_capacity - p_quantity
  where id = p_show_id
    and native_ticket_capacity >= p_quantity;

  if not found then
    -- Sold out between session creation and confirmation — the session row
    -- stays recorded so retries remain no-ops; the caller surfaces the
    -- conflict to the payer.
    select native_ticket_capacity into remaining from public.shows where id = p_show_id;
    return jsonb_build_object('outcome', 'insufficient_capacity', 'remaining', remaining);
  end if;

  select native_ticket_capacity into remaining from public.shows where id = p_show_id;
  return jsonb_build_object('outcome', 'recorded', 'remaining', remaining);
end;
$$;

-- ---------------------------------------------------------------------------
-- Don Engine sandbox: Plaid Link tokens, KYC outcomes, UDR ledger, BaaS rails.
-- ---------------------------------------------------------------------------

create table if not exists public.plaid_link_tokens (
  id           text primary key,
  creator_id   text not null,
  link_token   text not null unique,
  public_token text not null unique,
  access_token text not null,
  expiration   timestamptz not null,
  products     text not null,
  created_at   timestamptz not null
);

create table if not exists public.kyc_verifications (
  id                  text primary key,
  creator_id          text not null,
  plaid_link_token    text,
  plaid_public_token  text,
  status              text not null,
  identity_json       text not null,
  failure_reason      text,
  created_at          timestamptz not null,
  verified_at         timestamptz,
  insertion_order     bigint generated always as identity
);

create table if not exists public.split_runs (
  id                     text primary key,
  source                 text not null,
  period                 text,
  currency               text not null default 'USD',
  gross_cents            bigint not null,
  line_item_count        integer not null,
  variance_account_cents bigint not null default 0,
  created_at             timestamptz not null,
  status                 text not null default 'posted'
);

create table if not exists public.royalty_line_items (
  id            text primary key,
  split_run_id  text not null,
  work_id       text not null,
  work_title    text not null,
  amount_cents  bigint not null,
  splits_json   text not null,
  created_at    timestamptz not null,
  insertion_order bigint generated always as identity
);

create table if not exists public.ledger_transactions (
  id               text primary key,
  split_run_id     text not null,
  line_item_id     text not null,
  payee_id         text not null,
  payee_name       text not null,
  role             text not null,
  share_bps        integer not null,
  amount_cents     bigint not null,
  currency         text not null default 'USD',
  status           text not null,
  rail             text,
  baas_provider    text,
  baas_transfer_id text,
  created_at       timestamptz not null,
  settled_at       timestamptz,
  kind             text not null default 'royalty',
  insertion_order  bigint generated always as identity
);

create table if not exists public.baas_transfers (
  id                    text primary key,
  provider              text not null,
  rail                  text not null,
  payee_id              text not null,
  payee_name            text not null,
  amount_cents          bigint not null,
  currency              text not null default 'USD',
  status                text not null,
  ledger_transaction_id text,
  created_at            timestamptz not null,
  estimated_settlement  timestamptz,
  insertion_order       bigint generated always as identity
);

create table if not exists public.company_dust_ledger (
  id                  text primary key,
  split_run_id        text not null,
  line_item_id        text not null,
  amount_cents        bigint not null,
  variance_account_id text not null,
  created_at          timestamptz not null,
  insertion_order     bigint generated always as identity
);

create table if not exists public.creator_tax_profiles (
  creator_id   text primary key,
  tin_verified integer not null default 0 check (tin_verified in (0, 1)),
  w9_on_file   integer not null default 0 check (w9_on_file in (0, 1)),
  updated_at   timestamptz not null
);

create table if not exists public.creator_ytd_earnings (
  creator_id     text not null,
  tax_year       integer not null,
  gross_cents    bigint not null default 0,
  withheld_cents bigint not null default 0,
  updated_at     timestamptz not null,
  primary key (creator_id, tax_year)
);

create table if not exists public.tax_escrow_ledger (
  id                       text primary key,
  creator_id               text not null,
  tax_year                 integer not null,
  gross_cents              bigint not null,
  withheld_cents           bigint not null,
  net_cents                bigint not null,
  tin_verified             integer not null check (tin_verified in (0, 1)),
  w9_on_file               integer not null check (w9_on_file in (0, 1)),
  requires_1099            integer not null check (requires_1099 in (0, 1)),
  crossed_1099_threshold   integer not null check (crossed_1099_threshold in (0, 1)),
  created_at               timestamptz not null,
  insertion_order          bigint generated always as identity
);

create table if not exists public.sovereign_vaults (
  payee_id          text primary key,
  payee_name        text not null,
  available_balance bigint not null default 0,
  pending_balance   bigint not null default 0,
  reserve_balance   bigint not null default 0,
  updated_at        timestamptz not null
);

create table if not exists public.plaid_processor_tokens (
  id              text primary key,
  creator_id      text not null,
  public_token    text not null,
  processor       text not null,
  processor_token text not null,
  account_id      text not null,
  created_at      timestamptz not null,
  unique (public_token, processor)
);

create table if not exists public.recoupment_advances (
  creator_id               text primary key,
  creator_name             text not null,
  recoupment_target_cents  bigint not null,
  recoupment_current_cents bigint not null default 0,
  recoupment_bps           integer not null default 10000,
  updated_at               timestamptz not null
);

create table if not exists public.vault_disputes (
  payee_id             text primary key,
  locked               integer not null default 0 check (locked in (0, 1)),
  line_item_id         text,
  frozen_from_available bigint not null default 0,
  frozen_from_pending  bigint not null default 0,
  updated_at           timestamptz not null
);

create table if not exists public.payout_holds (
  transfer_id text primary key,
  payee_id    text not null,
  amount_cents bigint not null,
  status      text not null,
  created_at  timestamptz not null
);

create table if not exists public.baas_webhook_events (
  id           text primary key,
  event_id     text not null unique,
  event        text not null,
  transfer_id  text not null,
  payload_json text not null,
  reversal_id  text,
  created_at   timestamptz not null
);

create table if not exists public.payout_reversals (
  id                    text primary key,
  transfer_id           text not null,
  payee_id              text not null,
  amount_cents          bigint not null,
  reason                text not null,
  ledger_transaction_id text,
  journal_id            text not null,
  created_at            timestamptz not null
);

-- The append-only hash-chained GL: chain state (sequence, prev_hash,
-- entry_hash) lives on the journal; entries are the account legs.
create table if not exists public.gl_journals (
  id           text primary key,
  kind         text not null,
  ref_type     text not null,
  ref_id       text not null,
  created_at   timestamptz not null,
  sequence     integer not null default 0,
  prev_hash    text not null default '',
  entry_hash   text not null default '',
  state        text not null default 'posted',
  insertion_order bigint generated always as identity
);

create table if not exists public.gl_entries (
  id              text primary key,
  journal_id      text not null,
  account         text not null,
  debit_cents     bigint not null default 0,
  credit_cents    bigint not null default 0,
  created_at      timestamptz not null,
  insertion_order bigint generated always as identity
);

create table if not exists public.recoupment_ledger (
  id                       text primary key,
  creator_id               text not null,
  split_run_id             text not null,
  incoming_cents           bigint not null,
  recouped_cents           bigint not null,
  excess_cents             bigint not null,
  recoupment_current_cents bigint not null,
  created_at               timestamptz not null,
  insertion_order          bigint generated always as identity
);

create table if not exists public.catalog_disputes (
  work_id    text primary key,
  locked     integer not null default 0 check (locked in (0, 1)),
  updated_at timestamptz not null
);

create table if not exists public.dsp_webhook_events (
  id            text primary key,
  event_id      text not null unique,
  event         text not null,
  source        text not null,
  split_run_id  text,
  payload_json  text not null,
  created_at    timestamptz not null
);

create table if not exists public.split_reversals (
  id           text primary key,
  split_run_id text not null unique,
  journal_id   text not null,
  created_at   timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Lookup indexes for the store's list-by access paths (the canonical SQLite
-- schema relies on full scans; these change no semantics, only scale).
-- ---------------------------------------------------------------------------

create index if not exists idx_shows_created_at on public.shows (created_at desc);
create index if not exists idx_live_pings_artist on public.live_pings (artist_id);
create index if not exists idx_artists_key_hash on public.artists (key_hash);
create index if not exists idx_checkout_sessions_show on public.checkout_sessions (show_id);
create index if not exists idx_kyc_verifications_creator on public.kyc_verifications (creator_id);
create index if not exists idx_royalty_line_items_split_run on public.royalty_line_items (split_run_id);
create index if not exists idx_ledger_transactions_split_run on public.ledger_transactions (split_run_id);
create index if not exists idx_ledger_transactions_line_item on public.ledger_transactions (line_item_id);
create index if not exists idx_ledger_transactions_transfer on public.ledger_transactions (baas_transfer_id);
create index if not exists idx_company_dust_split_run on public.company_dust_ledger (split_run_id);
create index if not exists idx_tax_escrow_creator_year on public.tax_escrow_ledger (creator_id, tax_year);
create index if not exists idx_payout_holds_payee on public.payout_holds (payee_id);
create index if not exists idx_payout_reversals_transfer on public.payout_reversals (transfer_id);
create index if not exists idx_gl_journals_ref on public.gl_journals (ref_type, ref_id);
create index if not exists idx_gl_entries_journal on public.gl_entries (journal_id);
create index if not exists idx_recoupment_ledger_split_run on public.recoupment_ledger (split_run_id);

-- ---------------------------------------------------------------------------
-- Authorization: RLS deny-all (no policies) + full service-role grants, the
-- migrations 0001–0005 convention. The engine's store is the only writer.
-- ---------------------------------------------------------------------------

alter table public.shows enable row level security;
alter table public.live_pings enable row level security;
alter table public.artists enable row level security;
alter table public.checkout_sessions enable row level security;
alter table public.plaid_link_tokens enable row level security;
alter table public.kyc_verifications enable row level security;
alter table public.split_runs enable row level security;
alter table public.royalty_line_items enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.baas_transfers enable row level security;
alter table public.company_dust_ledger enable row level security;
alter table public.creator_tax_profiles enable row level security;
alter table public.creator_ytd_earnings enable row level security;
alter table public.tax_escrow_ledger enable row level security;
alter table public.sovereign_vaults enable row level security;
alter table public.plaid_processor_tokens enable row level security;
alter table public.recoupment_advances enable row level security;
alter table public.vault_disputes enable row level security;
alter table public.payout_holds enable row level security;
alter table public.baas_webhook_events enable row level security;
alter table public.payout_reversals enable row level security;
alter table public.gl_journals enable row level security;
alter table public.gl_entries enable row level security;
alter table public.recoupment_ledger enable row level security;
alter table public.catalog_disputes enable row level security;
alter table public.dsp_webhook_events enable row level security;
alter table public.split_reversals enable row level security;

grant all on public.shows to service_role;
grant all on public.live_pings to service_role;
grant all on public.artists to service_role;
grant all on public.checkout_sessions to service_role;
grant all on public.plaid_link_tokens to service_role;
grant all on public.kyc_verifications to service_role;
grant all on public.split_runs to service_role;
grant all on public.royalty_line_items to service_role;
grant all on public.ledger_transactions to service_role;
grant all on public.baas_transfers to service_role;
grant all on public.company_dust_ledger to service_role;
grant all on public.creator_tax_profiles to service_role;
grant all on public.creator_ytd_earnings to service_role;
grant all on public.tax_escrow_ledger to service_role;
grant all on public.sovereign_vaults to service_role;
grant all on public.plaid_processor_tokens to service_role;
grant all on public.recoupment_advances to service_role;
grant all on public.vault_disputes to service_role;
grant all on public.payout_holds to service_role;
grant all on public.baas_webhook_events to service_role;
grant all on public.payout_reversals to service_role;
grant all on public.gl_journals to service_role;
grant all on public.gl_entries to service_role;
grant all on public.recoupment_ledger to service_role;
grant all on public.catalog_disputes to service_role;
grant all on public.dsp_webhook_events to service_role;
grant all on public.split_reversals to service_role;
grant execute on function public.record_checkout_purchase(text, text, integer) to service_role;

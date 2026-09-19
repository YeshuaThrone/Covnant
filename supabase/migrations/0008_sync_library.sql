-- ============================================================================
-- Covnant — Sync Library catalog + licensing settlement (0008)
-- The SyncMarketplaceRegistry amendment (clearinghouse kernel spec
-- art_ZIdWlYUX). Two additive pieces, nothing else:
--
--  1. The sync-library catalog columns on cbt_assets — the pending
--     pre-clearance state, the instant-licensing fee, and the genre/BPM
--     metadata the catalog view renders. The asset's IDENTITY (title,
--     medium, rights_holders, created_timestamp) stays untouched in
--     cbt_assets; these are additive, nullable-defaulted columns, never a
--     new asset table. Registration lands every submission with
--     is_pre_cleared = false; only a gated administrator action flips it.
--  2. sync_license_purchases — the licensing settlement lane's write-back
--     record: one row per settled sync license purchase, keyed by the
--     SERVER-MINTED CBT settlement stamp (unique — the replay key;
--     duplicate purchases land on the idempotent existing row), linked to
--     the single split run that partitioned the fee 50/35/15.
--
-- Conventions, per migrations 0004–0007:
--  - Text UUIDs supplied by the store seam and timestamptz walls written
--    as ISO strings by the store.
--  - bigint generated always as identity = insertion_order (rowid
--    substitute for stable list tie-breaks).
--  - Money is integer cents here (the lane's payloads are integer cents);
--    the wire's micro-text rule is unchanged for its own tables.
--  - Every statement is `if not exists`-idempotent — re-running is a no-op.
--  - RLS is enabled with no policies (deny-all); only the service role
--    (the Don Engine store) reads and writes.
--  - Locked SQL column inventories (0001 cbt_assets, 0006 Don Engine,
--    0007 SDK collection) are NOT modified — this file adds columns and
--    one table only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Sync Library catalog columns (additive on cbt_assets).
-- ---------------------------------------------------------------------------
alter table public.cbt_assets
  add column if not exists is_pre_cleared boolean not null default false;

alter table public.cbt_assets
  add column if not exists sync_fee_cents integer not null default 0;

alter table public.cbt_assets
  add column if not exists genre text not null default '';

alter table public.cbt_assets
  add column if not exists bpm integer;

comment on column public.cbt_assets.is_pre_cleared is
  'Sync Library pre-clearance state — false (pending) until a gated administrator clears the asset; only cleared assets render in the sync catalog.';
comment on column public.cbt_assets.sync_fee_cents is
  'Instant sync-licensing cost in integer cents for this asset.';
comment on column public.cbt_assets.genre is
  'Free-form genre label shown in the sync catalog; empty until registered.';
comment on column public.cbt_assets.bpm is
  'Tempo (beats per minute) for sync search; null until registered.';

-- ---------------------------------------------------------------------------
-- sync_license_purchases — the settlement lane's write-back record.
-- One row per settled purchase; the stamp is server-minted per purchase
-- reference and UNIQUE, so replay is a read of the existing row. Never
-- updated after insert (append-only; reversals are a later lane's surface).
-- ---------------------------------------------------------------------------
create table if not exists public.sync_license_purchases (
  id text primary key,
  cvt_asset_tag text not null,
  buyer_uct text not null,
  license_type text not null,
  fee_paid_cents integer not null,
  cbt_settlement_stamp text not null unique,
  split_run_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  insertion_order bigint generated always as identity
);

create index if not exists sync_license_purchases_asset_idx
  on public.sync_license_purchases (cvt_asset_tag, created_at);

comment on table public.sync_license_purchases is
  'Write-back record for settled Sync License purchases: the server-minted CBT settlement stamp (unique replay key) linked to the split run that partitioned the fee 50/35/15.';
comment on column public.sync_license_purchases.license_type is
  'Licensing-rights vocabulary — values COMMERCIAL_SYNC, FILM_TV, GAMING, PODCAST (distinct from ContractCategory and MediaMedium).';
comment on column public.sync_license_purchases.cbt_settlement_stamp is
  'The clearing side''s server-minted CBT settlement stamp (withCbtSettlementCode over the purchase reference). Unique — duplicate purchases land on the idempotent existing row.';

-- ---------------------------------------------------------------------------
-- Row-level security: enabled, zero policies — deny-all by default. The
-- service role bypasses RLS and is the only writer (the store seam).
-- ---------------------------------------------------------------------------
alter table public.sync_license_purchases enable row level security;

grant usage on schema public to service_role;
grant all on public.sync_license_purchases to service_role;

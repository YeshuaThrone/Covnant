-- ============================================================================
-- Covnant — Covenant Platform initial schema (migration 0001)
-- Tables match the vendored CovenantMasterSDK engine column-for-column:
--   cbt_assets                 <- engine registerCBTAsset / getOrHydrateAsset
--   universal_royalty_ledger   <- engine processUniversalSocialWebhookAction
--   platform_allowlists        <- engine CovenantGlobalSocialEngine hydration
-- v1 ships without authentication; RLS is enabled with service-role-only
-- policies. When auth ships, replace the deny-all policies with real ones.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Covenant Block assets: one row per registered creative asset.
-- ---------------------------------------------------------------------------
create table if not exists public.cbt_assets (
  id                 uuid primary key default gen_random_uuid(),
  cbt_code           text not null unique,
  title              text not null,
  medium             text not null,
  mapped_identifiers jsonb not null default '{}'::jsonb,
  rights_holders     jsonb not null default '[]'::jsonb,
  created_timestamp  bigint not null,
  created_at         timestamptz not null default now()
);

create index if not exists idx_cbt_assets_cbt_code on public.cbt_assets (cbt_code);

-- ---------------------------------------------------------------------------
-- Universal royalty ledger: settled transactions with reconciliation data.
-- ---------------------------------------------------------------------------
create table if not exists public.universal_royalty_ledger (
  id                     uuid primary key default gen_random_uuid(),
  transaction_id         text not null unique,
  cbt_code               text not null,
  platform               text not null,
  gross_settled          numeric(20, 8) not null,
  covenant_fee           numeric(20, 8) not null default 0,
  corner_dust_collected  numeric(20, 8) not null default 0,
  currency               text not null,
  disbursements          jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now()
);

create index if not exists idx_royalty_ledger_cbt_code on public.universal_royalty_ledger (cbt_code);

-- ---------------------------------------------------------------------------
-- Platform allowlists: pre-cleared channel IDs per platform + asset.
-- ---------------------------------------------------------------------------
create table if not exists public.platform_allowlists (
  id                          uuid primary key default gen_random_uuid(),
  platform                    text not null,
  target_account_id           text not null,
  cbt_code                    text not null,
  creator_incentive_share_pct numeric(5, 4) not null default 0,
  status                      text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  created_at                  timestamptz not null default now(),
  unique (platform, target_account_id, cbt_code)
);

-- ---------------------------------------------------------------------------
-- Row Level Security: service-role writes only until auth ships (v1).
-- ---------------------------------------------------------------------------
alter table public.cbt_assets enable row level security;
alter table public.universal_royalty_ledger enable row level security;
alter table public.platform_allowlists enable row level security;

-- deny-all default policies (service role bypasses RLS)
create policy "deny_anon_cbt_assets" on public.cbt_assets for all using (false) with check (false);
create policy "deny_anon_ledger" on public.universal_royalty_ledger for all using (false) with check (false);
create policy "deny_anon_allowlists" on public.platform_allowlists for all using (false) with check (false);

-- ============================================================================
-- Covnant — Creator gateway telemetry schema (migration 0003)
-- Additive tables for the CovnantSDK gateway backend wiring:
--   creator_telemetry         <- POST /api/users/register (verified callers)
--   platform_admin_allowlists <- GET /api/admin/ledger (CEO/admin gate)
-- Existing tables (cbt_assets, universal_royalty_ledger, platform_allowlists,
-- contracts) are intentionally untouched.
--
-- RLS contract:
--   creator_telemetry          INSERT: authenticated callers persist only
--                              their own telemetry (auth.uid() = auth_user_id).
--                              SELECT: admin-gated — the caller must hold a
--                              platform_admin_allowlists row.
--   platform_admin_allowlists  SELECT: own row only. This is what lets the
--                              admin-gated telemetry policy (and the server
--                              routes' explicit checks) resolve the caller's
--                              identity without exposing anyone else's rows.
-- Seeding the CEO (manual step — run in the Supabase dashboard once the auth
-- user exists):
--   insert into public.platform_admin_allowlists (auth_user_id, role)
--   values ('<supabase-auth-user-uuid>', 'CEO');
-- ============================================================================

-- auth.uid() shim -------------------------------------------------------------
-- The hosted Supabase project provides auth.uid() (reads the JWT subject from
-- request.jwt.claims). A scratch Postgres — the CI schema job applies
-- migrations to one — does not, and CREATE POLICY validates its expression up
-- front. Create the function only when it is absent so the authentic Supabase
-- function is never shadowed.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'auth') then
    create schema auth;
  end if;
  if to_regprocedure('auth.uid()') is null then
    execute $fn$
      create function auth.uid() returns uuid
      language sql stable
      as $inner$
        select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
      $inner$
    $fn$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Creator telemetry: one row per verified gateway registration.
-- ---------------------------------------------------------------------------
create table if not exists public.creator_telemetry (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid,
  legal_name     text not null,
  artist_name    text not null,
  regular_email  text not null,
  business_email text,
  phone          text not null,
  phone_verified boolean not null default false,
  verified_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists idx_creator_telemetry_auth_user on public.creator_telemetry (auth_user_id);

-- ---------------------------------------------------------------------------
-- Platform admin allowlist: Supabase auth user ids cleared for admin reads.
-- ---------------------------------------------------------------------------
create table if not exists public.platform_admin_allowlists (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique,
  role         text not null default 'CEO' check (role in ('CEO', 'ADMIN')),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.creator_telemetry enable row level security;
alter table public.platform_admin_allowlists enable row level security;

-- creator_telemetry: authenticated callers may persist their own telemetry only.
drop policy if exists "telemetry insert self" on public.creator_telemetry;
create policy "telemetry insert self" on public.creator_telemetry
  for insert with check (auth.uid() = auth_user_id);

-- creator_telemetry: admin-gated reads — the caller must hold an allowlist row.
drop policy if exists "telemetry select admin" on public.creator_telemetry;
create policy "telemetry select admin" on public.creator_telemetry
  for select using (
    exists (
      select 1 from public.platform_admin_allowlists a
      where a.auth_user_id = auth.uid()
    )
  );

-- platform_admin_allowlists: deny-all default (service role bypasses RLS)...
drop policy if exists "admin allowlist deny all" on public.platform_admin_allowlists;
create policy "admin allowlist deny all" on public.platform_admin_allowlists
  for all using (false) with check (false);

-- ...plus own-row reads so the admin-gated policies can resolve the caller.
drop policy if exists "admin allowlist read own" on public.platform_admin_allowlists;
create policy "admin allowlist read own" on public.platform_admin_allowlists
  for select using (auth.uid() = auth_user_id);

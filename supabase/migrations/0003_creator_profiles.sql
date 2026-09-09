-- ============================================================================
-- Covnant — Creator profiles schema (migration 0003)
-- Table matches the signup route's profile persistence column-for-column:
--   creator_profiles <- src/app/api/covnant/auth/signup/route.ts
-- One row per creator identity, keyed to the Supabase Auth user (the auth
-- user owns the password; this table owns the profile). `title` is nullable
-- by ruling: the landing currently captures Core Industry & Title as one
-- combined field, so the API cannot always supply both values separately
-- (PR C splits the field).
-- RLS: service_role (the API's admin client) bypasses RLS for inserts;
-- owner policies serve future client-side reads/updates.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Creator profiles: one row per creator, keyed to the auth user.
-- ---------------------------------------------------------------------------
create table if not exists public.creator_profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  stage_name           text not null,
  legal_name           text not null,
  email                text not null,
  phone                text,
  phone_verified_at    timestamptz,
  core_industry        text not null,
  title                text,
  udr_terms_accepted_at timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

create unique index if not exists creator_profiles_email_key
  on public.creator_profiles (email);

alter table public.creator_profiles enable row level security;

drop policy if exists "creator profiles: select own" on public.creator_profiles;
create policy "creator profiles: select own" on public.creator_profiles
  for select using (auth.uid() = id);

drop policy if exists "creator profiles: update own" on public.creator_profiles;
create policy "creator profiles: update own" on public.creator_profiles
  for update using (auth.uid() = id);

grant select, update on public.creator_profiles to authenticated;
grant all on public.creator_profiles to service_role;

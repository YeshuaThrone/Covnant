-- ============================================================================
-- Covnant — Contract Vault schema (migration 0002)
-- Table matches the vault adapter column-for-column:
--   contracts <- src/lib/contracts/store.ts (draft -> final -> export)
-- v1 ships without authentication; RLS is enabled with service-role-only
-- policies. When auth ships, replace the deny-all policies with real ones.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Contracts: one row per generated agreement draft or final document.
-- ---------------------------------------------------------------------------
create table if not exists public.contracts (
  id          text primary key,
  cbt_code    text not null,
  template_id text not null,
  industry    text not null check (industry in ('MUSIC', 'FILM_MEDIA_MERCH')),
  status      text not null default 'DRAFT' check (status in ('DRAFT', 'FINAL')),
  fields      jsonb not null default '{}'::jsonb,
  document    text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_contracts_cbt_code on public.contracts (cbt_code);

alter table public.contracts enable row level security;
drop policy if exists "deny all" on public.contracts;
create policy "deny all" on public.contracts for all using (false) with check (false);

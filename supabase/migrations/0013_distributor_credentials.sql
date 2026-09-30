-- ---------------------------------------------------------------------------
-- Migration 0013 — distributor_connections (the UCT credential vault, PR 5).
--
-- Creators hand Covnant their distributor credentials (DistroKid, TuneCore,
-- ASCAP, BMI) so the Astra extraction agent can traverse dashboards with
-- zero manual uploads. The table stores those credentials ENCRYPTED — the
-- plaintext exists only in the request body and in the app-side cipher call,
-- never in a response, never in a log, and never in this table:
--
--   username_encrypted / password_encrypted carry the AES-256-GCM wire
--   format of src/modules/vault/crypto.ts (`enc:v1:<iv>.<tag>.<ciphertext>`,
--   the same convention as the Plaid token crypto). No pgcrypto column
--   variant: the app is already the crypto boundary for Plaid tokens, and
--   one cipher implementation means one audit surface.
--
-- Holder scoping: RLS is the house deny-all (no policies — 0006/0010/0011
-- convention), so the anon/authenticated keys read nothing; the service-role
-- store seam is the only reader/writer, and EVERY store method takes the
-- holder id as its first argument. "Holder-scoped auth" is the route +
-- store contract, not a Postgres policy: the holder id comes from the
-- VERIFIED session (resolveSessionCreator), never a client field, and a
-- foreign (holder, id) pair is indistinguishable from an unknown id — the
-- OTP no-enumeration rule.
--
-- House pattern (0006/0011): check-constrained vocabularies, RLS deny-all,
-- full service_role grant, insertion_order bigint. Idempotent — CI applies
-- it twice; every object uses IF NOT EXISTS / OR REPLACE / guarded DO.
-- ---------------------------------------------------------------------------

create table if not exists public.distributor_connections (
  id                 uuid primary key default gen_random_uuid(),
  holder_id          uuid not null,
  -- creator_profiles.id (0003) — the Don store's payee key, the session's
  -- own holder id. No FK on purpose, matching 0011's requested_by: the
  -- store seam and the verified session are the integrity boundary.
  distributor        text not null
                     check (distributor in ('distrokid', 'tunecore', 'ascap', 'bmi')),
  status             text not null default 'connected'
                     check (status in ('connected', 'disconnected')),
  -- AES-256-GCM ciphertext (`enc:v1:...`, src/modules/vault/crypto.ts).
  -- The plaintext of either credential NEVER reaches any column.
  username_encrypted text not null,
  password_encrypted text not null,
  -- Astra extraction provenance — written by the agent lane (PR 6), not
  -- the connect routes. null = never traversed.
  last_verified_at   timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  insertion_order    bigint generated always as identity
);

comment on table public.distributor_connections is
  'The UCT credential vault (PR 5): one ACTIVE connection per (holder, distributor) — reconnecting rotates the ciphertexts in place. Credentials are stored only as AES-256-GCM ciphertext (src/modules/vault/crypto.ts); plaintext is never stored, returned, or logged.';
comment on column public.distributor_connections.holder_id is
  'creator_profiles id (0003) — the verified session''s payee key. Every store method scopes by this column first; a foreign holder sees a 404, never an existence hint.';
comment on column public.distributor_connections.distributor is
  'The dashboard the credentials unlock — values distrokid, tunecore, ascap, bmi (house lowercase; the four launch sources the Astra agent traverses).';
comment on column public.distributor_connections.status is
  'Connection lifecycle — values connected, disconnected. Only ONE connected row may exist per (holder_id, distributor) — the partial unique index below; disconnect keeps the row (status disconnected) so the holder sees their own history, and a reconnect after disconnect inserts a fresh row.';
comment on column public.distributor_connections.username_encrypted is
  'AES-256-GCM ciphertext of the login identifier — `enc:v1:<iv>.<tag>.<ciphertext>` base64url (src/modules/vault/crypto.ts). Never returned by any route.';
comment on column public.distributor_connections.password_encrypted is
  'AES-256-GCM ciphertext of the password — same wire format. Never returned by any route.';
comment on column public.distributor_connections.last_verified_at is
  'When the Astra agent last traversed the dashboard successfully (PR 6); null = never traversed.';
comment on column public.distributor_connections.last_error is
  'The most recent traversal failure reason (PR 6); null = no failure recorded. A traversal failure NEVER changes status — disconnect is the holder''s explicit act.';

-- The status read: a holder's rows, newest first.
create index if not exists idx_distributor_connections_holder
  on public.distributor_connections (holder_id, status, insertion_order);

-- ONE active connection per (holder, distributor). Partial — disconnected
-- rows never block a reconnect. The store seam enforces rotate-in-place on
-- the happy path; this index is the concurrency arbiter when two connects
-- race: Postgres rejects the second insert, the route fails closed.
create unique index if not exists uq_distributor_connections_active
  on public.distributor_connections (holder_id, distributor)
  where status = 'connected';

-- ---------------------------------------------------------------------------
-- Authorization: RLS deny-all (no policies) + full service-role grant, the
-- migrations 0001–0012 convention. The store seam — holder-scoped by its
-- method signatures — is the only reader/writer; the anon and authenticated
-- PostgREST keys can prove nothing about this table's contents.
-- ---------------------------------------------------------------------------

alter table public.distributor_connections enable row level security;
grant all on public.distributor_connections to service_role;

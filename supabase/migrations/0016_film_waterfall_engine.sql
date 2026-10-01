-- ---------------------------------------------------------------------------
-- Migration 0016 — film waterfall engine (Deep Royalties PR 8, todo_owdUMkDq).
--
-- The two tables the film waterfall engine owns:
--
--   film_waterfall_definitions — the registered deal. ONE validated waterfall
--     per film asset (jsonb): six tiers, strict sequential recoupment, the
--     First Dollar Gross terms. The TypeScript module
--     (src/modules/waterfall/engine.ts) is the validation gate — this table
--     stores what passed it, keyed one row per film.
--
--   film_waterfall_distributions — the routing-decision record. One row per
--     RELEASED escrow receipt (unique on escrow_ledger_id): the per-leg
--     routing detail that makes shortfall carry honest. The GL's tier legs
--     are per-TIER, so per-obligation cumulative paid state is not
--     recoverable from them when a bps leg and a fixed leg share a tier —
--     this record exists so the carry never guesses. Lifecycle: inserted
--     status 'routed' BEFORE the release moves money (insert-as-lock, the
--     payout_reversals precedent), flipped to 'applied' on release success,
--     DELETED when the release refuses (retryable). Cumulative paid sums
--     fold APPLIED rows only.
--
-- ADDITIVE migration at the next-free number (0011-0015 are taken). Nothing
-- existing is dropped or altered. House pattern (0006/0010/0011): check-
-- constrained status, RLS deny-all, full service_role grant, insertion_order
-- bigint. This file is idempotent — CI applies it twice; every object uses
-- IF NOT EXISTS.
-- ---------------------------------------------------------------------------

create table if not exists public.film_waterfall_definitions (
  film_id      text primary key,
  definition   jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.film_waterfall_definitions is
  'Film waterfall engine (PR 8): the registered deal — one validated six-tier waterfall per film asset, stored jsonb. The TypeScript engine is the registration gate; rows are what passed it.';
comment on column public.film_waterfall_definitions.film_id is
  'The film asset id — the same key film escrow routes through (payee film_escrow:{filmId}). One waterfall per film.';
comment on column public.film_waterfall_definitions.definition is
  'The full WaterfallDefinition: tiers 0-5 with typed leg structures (per_receipt_bps commission, fixed obligations, debt and equity recoupment, the tier-5 profit pool) and the deal''s First Dollar Gross terms.';

create table if not exists public.film_waterfall_distributions (
  id               uuid primary key default gen_random_uuid(),
  film_id          text not null,
  escrow_ledger_id text not null unique,
  status           text not null default 'routed'
                   check (status in ('routed', 'applied')),
  fdg_bypass_cents bigint not null default 0 check (fdg_bypass_cents >= 0),
  legs             jsonb not null,
  tier_allocations jsonb not null,
  unpaid_total_cents bigint not null default 0 check (unpaid_total_cents >= 0),
  created_at       timestamptz not null default now(),
  insertion_order  bigint generated always as identity
);

comment on table public.film_waterfall_distributions is
  'Film waterfall engine (PR 8): the routing-decision record — one row per released escrow receipt, carrying the per-leg routing detail that makes shortfall carry honest. Inserted routed before the money moves, applied on success, deleted when the release refuses.';
comment on column public.film_waterfall_distributions.escrow_ledger_id is
  'The released escrow receipt — ledger_transactions.id (text, 0006). UNIQUE: one routing decision per released receipt, ever; a duplicate insert throws and the caller recovers by reading the existing row.';
comment on column public.film_waterfall_distributions.status is
  'Routing lifecycle — routed (the decision is locked, money not yet moved) then applied (the release succeeded). Cumulative per-leg paid state folds APPLIED rows only; a deleted routed row releases the escrow receipt for retry.';
comment on column public.film_waterfall_distributions.fdg_bypass_cents is
  'The First Dollar Gross bypass taken off the top of the receipt, integer cents — the deal''s gross-point contract, computed before any tier sees a cent.';
comment on column public.film_waterfall_distributions.legs is
  'The per-leg routing detail: every defined leg in routing order with demand, routed, unpaid, and cumulative-paid — the exact state the sequential router consumes for carry.';
comment on column public.film_waterfall_distributions.tier_allocations is
  'The positive per-tier totals the release applied as GL legs, integer cents.';
comment on column public.film_waterfall_distributions.unpaid_total_cents is
  'The honest carry this routing reported: the total lifetime balance still owed after the money moved.';

-- The film's routing history: cumulative paid folds oldest first, and the
-- film's waterfall dashboard reads the same order.
create index if not exists idx_film_waterfall_distributions_film
  on public.film_waterfall_distributions (film_id, created_at);

-- ---------------------------------------------------------------------------
-- Foreign keys: both tables hang off existing rows. ledger_transactions.id is
-- TEXT (0006) — the FK must match the referenced column's type exactly (the
-- 0011 statement_ingests precedent).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.film_waterfall_distributions'::regclass
      and conname = 'fk_film_waterfall_distributions_escrow'
  ) then
    alter table public.film_waterfall_distributions
      add constraint fk_film_waterfall_distributions_escrow
      foreign key (escrow_ledger_id) references public.ledger_transactions (id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Authorization: RLS deny-all (no policies) + full service-role grants, the
-- migrations 0001-0015 convention. The store seam is the only writer; the
-- engine and the escrow release are the only readers.
-- ---------------------------------------------------------------------------

alter table public.film_waterfall_definitions enable row level security;
alter table public.film_waterfall_distributions enable row level security;
grant all on public.film_waterfall_definitions to service_role;
grant all on public.film_waterfall_distributions to service_role;

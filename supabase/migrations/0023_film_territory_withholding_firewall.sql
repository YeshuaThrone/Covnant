-- -----------------------------------------------------------------------------
-- 0023 — Film multi-territory withholding + cross-collateralization firewall
--        (Deep Royalties PR 18, todo_Gp0QAVIo).
--
-- The two tables the film territory engine owns:
--
--   film_territory_withholdings — the per-line, pre-conversion foreign-
--     withholding log (addendum 6's territory_code + foreign_tax_withheld
--     fields, which the match-queue builder ships as null and this engine
--     consumes). The withholding is computed on the SOURCE-currency amount
--     at the territory's pinned treaty rate and logged BEFORE anything
--     converts into the Don ledger base currency: the row is the foreign-
--     tax-credit evidence and the rate+amount audit of record. UNIQUE on
--     event_id (the content-derived match_queue event) — one withholding
--     log per line, ever.
--
--   film_territory_distributions — the territory envelopes behind the
--     cross-collateralization firewall. One row per RELEASED escrow receipt
--     PER TERRITORY (unique on (escrow_ledger_id, territory_code)): the
--     per-leg routing detail computed from that territory's own money and
--     its own paid state, so the shortfall carry stays per-territory and no
--     pooled allocation can pass the firewall. Lifecycle mirrors the parent
--     film_waterfall_distributions record (0016): inserted status 'routed'
--     BEFORE the release moves money (insert-as-lock), flipped 'applied' on
--     release success, DELETED when the release refuses (retryable).
--     cross_applications records the CAMA-permitted sweeps — null unless the
--     territory's envelope was routed with the explicit override, which the
--     DDL enforces (the default-deny firewall as a database invariant).
--
-- ADDITIVE migration at the next-free number (0011-0022 are taken). Nothing
-- existing is dropped or altered. House pattern (0016/0017/0019-0022): check-
-- constrained status, RLS deny-all, full service_role grant, insertion_order
-- bigint. This file is idempotent — CI applies it twice; every object uses
-- IF NOT EXISTS.
-- -----------------------------------------------------------------------------

create table if not exists public.film_territory_withholdings (
  id                     uuid primary key default gen_random_uuid(),
  event_id               text not null unique,
  film_id                text not null,
  territory_code         text not null,
  foreign_tax_withheld   boolean not null default false,
  withholding_rate_bps   integer not null default 0
                         check (withholding_rate_bps >= 0 and withholding_rate_bps <= 10000),
  rate_table_version     text,
  source_currency        text not null,
  gross_source_micros    text not null,
  withheld_source_micros text not null,
  net_source_micros      text not null,
  base_currency          text not null,
  fx_rate_micros         bigint not null check (fx_rate_micros >= 0),
  gross_base_cents       bigint not null check (gross_base_cents >= 0),
  withheld_base_cents    bigint not null check (withheld_base_cents >= 0),
  net_base_cents         bigint not null check (net_base_cents >= 0),
  created_at             timestamptz not null default now(),
  insertion_order        bigint generated always as identity,
  constraint film_territory_withholdings_rate_consistency_check
    check (
      (foreign_tax_withheld and withholding_rate_bps > 0 and rate_table_version is not null)
      or
      (not foreign_tax_withheld and withholding_rate_bps = 0 and rate_table_version is null)
    )
);

comment on table public.film_territory_withholdings is
  'Film territory engine (PR 18): the per-line foreign-withholding log — computed on the source-currency amount at the territory''s pinned treaty rate and logged BEFORE base-currency conversion. The row is the foreign-tax-credit evidence and the rate+amount audit of record.';
comment on column public.film_territory_withholdings.event_id is
  'The ingested film line — match_queue.event_id (addendum 6, 0011). UNIQUE: one withholding log per line, ever; a replayed line recovers by reading the existing row.';
comment on column public.film_territory_withholdings.territory_code is
  'The film tax jurisdiction (ISO 3166-1 alpha-2) the line''s withholding was computed in.';
comment on column public.film_territory_withholdings.withholding_rate_bps is
  'The applied treaty rate in bps — 0 when the line was not withheld (the consistency check pairs a withheld line with a positive rate and a rate-table version, an unwithheld line with zero and null).';
comment on column public.film_territory_withholdings.rate_table_version is
  'The versioned rate table consulted — pinned so a later rate change cannot silently rewrite history. Null when the line was not withheld.';
comment on column public.film_territory_withholdings.source_currency is
  'The statement''s own denomination — the withholding is computed here, before any conversion.';
comment on column public.film_territory_withholdings.gross_source_micros is
  'Exact source gross as decimal micros TEXT — never a float (the gaming accumulator''s micros discipline).';
comment on column public.film_territory_withholdings.withheld_source_micros is
  'Exact source withheld as decimal micros TEXT — the withholding at the pinned rate, floored at the line boundary.';
comment on column public.film_territory_withholdings.net_source_micros is
  'Exact source net as decimal micros TEXT — gross minus withheld; the only amount that converts.';
comment on column public.film_territory_withholdings.base_currency is
  'The Don ledger base currency the net posts into.';
comment on column public.film_territory_withholdings.fx_rate_micros is
  'The applied FX rate (micros of base per source unit), logged with the conversion so the escrow''s base-currency post is reproducible.';
comment on column public.film_territory_withholdings.gross_base_cents is
  'Whole base-currency cents the gross converts to — the log carries all three; the escrow posts the NET only.';

-- The film's withholding history: the film's territory tax report reads it
-- in log order.
create index if not exists idx_film_territory_withholdings_film
  on public.film_territory_withholdings (film_id, created_at);

create table if not exists public.film_territory_distributions (
  id                              uuid primary key default gen_random_uuid(),
  film_id                         text not null,
  escrow_ledger_id                text not null,
  territory_code                  text not null,
  status                          text not null default 'routed'
                                  check (status in ('routed', 'applied')),
  fdg_bypass_cents                bigint not null default 0 check (fdg_bypass_cents >= 0),
  legs                            jsonb not null,
  tier_allocations                jsonb not null,
  unpaid_total_cents              bigint not null default 0 check (unpaid_total_cents >= 0),
  cross_collateralization_permitted boolean not null default false,
  cross_applications              jsonb,
  created_at                      timestamptz not null default now(),
  insertion_order                 bigint generated always as identity,
  unique (escrow_ledger_id, territory_code),
  constraint film_territory_distributions_no_cross_without_cama_check
    check (cross_collateralization_permitted or cross_applications is null)
);

comment on table public.film_territory_distributions is
  'Film territory engine (PR 18): one territory envelope''s routing decision on a released escrow receipt — the territory partition of film_waterfall_distributions (0016). Recoupment and expense nets are computed per territory from that territory''s own money and its own paid state and summed only for reporting, so a shortfall carry never crosses territory lines (the firewall).';
comment on column public.film_territory_distributions.escrow_ledger_id is
  'The released escrow receipt — ledger_transactions.id (text, 0006). UNIQUE with territory_code: one routing decision per released receipt per territory, ever; a duplicate insert throws and the caller recovers by reading the existing rows.';
comment on column public.film_territory_distributions.legs is
  'The per-leg routing detail for THIS territory''s envelope: every defined leg in routing order with demand, routed, unpaid, and cumulative-paid — computed from the territory''s own money, never the pooled receipt.';
comment on column public.film_territory_distributions.tier_allocations is
  'The positive per-tier totals this territory''s envelope routed as GL legs, integer cents.';
comment on column public.film_territory_distributions.unpaid_total_cents is
  'The honest per-territory carry this routing reported — the territory''s own lifetime balance still owed, which stays inside its envelope.';
comment on column public.film_territory_distributions.cross_collateralization_permitted is
  'The CAMA cross-collateralization flag as honored at routing (default false). False = the default-deny firewall: this envelope''s tiers route only its own money.';
comment on column public.film_territory_distributions.cross_applications is
  'The cross-territorial applications when the CAMA override fired — each records the debtor territory/leg and the exact cents that crossed, drawn ONLY from a creditor territory''s tier-5 profit-pool residue. Null when the override did not fire; the DDL refuses a non-null value without the flag.';

-- The film's territory-envelope history: the per-territory paid state folds
-- oldest first, and the film's multi-territory dashboard reads the same
-- order. The per-receipt lookup (crash repair, replay guard) reads by
-- escrow_ledger_id.
create index if not exists idx_film_territory_distributions_film
  on public.film_territory_distributions (film_id, insertion_order);
create index if not exists idx_film_territory_distributions_escrow
  on public.film_territory_distributions (escrow_ledger_id);

-- ---------------------------------------------------------------------------
-- Foreign keys: both tables hang off existing rows. match_queue.event_id is
-- TEXT not null unique (0007) and ledger_transactions.id is TEXT (0006) —
-- the FKs must match the referenced columns' types exactly (the 0011
-- statement_ingests precedent), added guarded (0016-0022).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.film_territory_withholdings'::regclass
      and conname = 'fk_film_territory_withholdings_event'
  ) then
    alter table public.film_territory_withholdings
      add constraint fk_film_territory_withholdings_event
      foreign key (event_id) references public.match_queue (event_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.film_territory_distributions'::regclass
      and conname = 'fk_film_territory_distributions_escrow'
  ) then
    alter table public.film_territory_distributions
      add constraint fk_film_territory_distributions_escrow
      foreign key (escrow_ledger_id) references public.ledger_transactions (id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Authorization: RLS deny-all (every policy false) + full service-role
-- grants, the migrations 0001-0022 convention. The store seam is the only
-- writer; the territory release path and the withholding report are the
-- only readers.
-- ---------------------------------------------------------------------------

alter table public.film_territory_withholdings enable row level security;
alter table public.film_territory_distributions enable row level security;

drop policy if exists film_territory_withholdings_service_role_all
  on public.film_territory_withholdings;
create policy film_territory_withholdings_service_role_all
  on public.film_territory_withholdings
  for all
  using (false)
  with check (false);

drop policy if exists film_territory_distributions_service_role_all
  on public.film_territory_distributions;
create policy film_territory_distributions_service_role_all
  on public.film_territory_distributions
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.film_territory_withholdings to service_role;
grant select, insert, update, delete on public.film_territory_distributions to service_role;

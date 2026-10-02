-- =============================================================================
-- 0031 — Foreign tax hold evidence + book returns reserve (PR 27)
--
-- The publishing payout protections' durable facts of record, per the
-- founder directive:
--
--   withholding_tax_credit_verifications
--     <- upsertWithholdingTaxCreditVerification /
--        getWithholdingTaxCreditVerification
--     (the VERIFIED withholding-tax-credit evidence per
--      (country_code, tax_year) — for example the US-UK treaty's credit
--      at treaty terms. UNIQUE per (country_code, tax_year): a re-record
--      converges (the evidence upgrade pending → verified replaces the
--      row atomically). A 'verified' state REQUIRES the treaty reference,
--      the evidence provenance, and the verifier — the state never lies
--      about the credit. The FOREIGN_TAX_HOLD ledger state thaws ONLY on
--      this row's 'verified' state; absent or pending evidence stays
--      fail-closed.)
--   isbn_rights_verifications <- upsertIsbnRightsVerification /
--                                 getIsbnRightsVerification
--     (the print title's rights chain of record per isbn. UNIQUE per
--      isbn: a re-verification replaces the row atomically. Only
--      'verified' passes the publishing payout gate's
--      isbn_rights_verified condition; absent, pending, and failed all
--      refuse, fail-closed.)
--   book_returns_reserve_policies <- upsertBookReturnsReservePolicy /
--                                    getBookReturnsReservePolicy
--     (the founder-banded money terms per ISBN: reserve_rate_bps whole
--      basis points in [1500, 2000] — 15% to 20% — and
--      reserve_window_days whole days in [90, 120], CHECK-enforced at
--      rest and lane-enforced at write.)
--   book_reserve_drawdowns       <- insertBookReserveDrawdown /
--                                   listBookReserveDrawdowns
--     (the append-only drawdown truth, the merch reserve discipline
--      (0027) at ISBN scope. UNIQUE per (reserve_ledger_id,
--      source_event_id): a re-shipped return/chargeback event is the
--      unique violation, never a double drawdown. UNIQUE per
--      (reserve_ledger_id, drawn_before_cents): the POSITION lock — the
--      insert-as-lock arbiter (the PR 12/PR 99/webtoon discipline). The
--      drawn sum IS the reserve's spend — derived, never a second
--      mutable counter.)
--   book_return_chargebacks      <- insertBookReturnChargeback /
--                                   getBookReturnChargeback /
--                                   listBookReturnChargebacks
--     (the publisher return chargeback of record per event_id. UNIQUE
--      per event_id: a re-shipped chargeback event is the counted no-op,
--      never a double record. Recovery splits two lanes: the title's
--      held reserves (book_reserve_drawdowns) and the outstanding
--      remainder's offset against incoming POD net
--      (book_chargeback_offset_applications).)
--   book_chargeback_offset_applications
--     <- insertBookChargebackOffsetApplication /
--        listBookChargebackOffsetApplications
--     (the append-only offset truth: the publisher's recovery taken OUT
--      of a specific held print allocation BEFORE author payouts
--      release. UNIQUE per (chargeback_id, holding_ledger_id): a
--      replayed release is the unique violation, never a double offset.
--      UNIQUE per (chargeback_id, offset_before_cents): the POSITION
--      lock — exactly one release wins an offset's next running
--      position per chargeback.)
--
-- The money discipline: every *_cents column is an integer cent count
-- (the Don ledger's whole-cents contract). Ledger-child tables carry the
-- 0027 foreign-key discipline (cascade on delete); the evidence and
-- policy tables are keyed by natural keys (isbn, country_code +
-- tax_year) with no ledger reference.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with a full service-role grant (the 0017–0030
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- withholding_tax_credit_verifications: the foreign-tax-credit evidence of
-- record per (country_code, tax_year). The FOREIGN_TAX_HOLD ledger state
-- reads this row's state — 'verified' thaws the hold; anything else
-- (absent, pending, failed) refuses, fail-closed.
-- ---------------------------------------------------------------------------
create table if not exists public.withholding_tax_credit_verifications (
  id           uuid primary key default gen_random_uuid(),
  country_code text not null,
  tax_year     integer not null,
  state        text not null,
  treaty_ref   text,
  evidence_ref text,
  verified_by  text,
  verified_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (country_code, tax_year),
  constraint withholding_tax_credit_verifications_state_check
    check (state in ('pending', 'verified', 'failed')),
  constraint withholding_tax_credit_verifications_year_check
    check (tax_year > 1900)
);

comment on table public.withholding_tax_credit_verifications is
  'The verified withholding-tax-credit evidence per (country_code, tax_year) — for example US-UK treaty evidence. UNIQUE (country_code, tax_year): a re-recording converges (the evidence upgrade pending → verified replaces the row atomically). A ''verified'' state requires treaty_ref, evidence_ref, and verified_by — the FOREIGN_TAX_HOLD ledger state thaws ONLY on verified; absent or pending evidence stays fail-closed.';

-- ---------------------------------------------------------------------------
-- isbn_rights_verifications: the print title's rights chain of record per
-- isbn. The publishing payout gate's isbn_rights_verified condition
-- resolves from this row — only 'verified' passes; absent, pending, and
-- failed refuse, fail-closed.
-- ---------------------------------------------------------------------------
create table if not exists public.isbn_rights_verifications (
  id          uuid primary key default gen_random_uuid(),
  isbn        text not null,
  state       text not null,
  evidence_ref text,
  verified_by text,
  verified_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (isbn),
  constraint isbn_rights_verifications_state_check
    check (state in ('pending', 'verified', 'failed'))
);

comment on table public.isbn_rights_verifications is
  'The print title''s verified rights chain of record per isbn. UNIQUE (isbn): a re-verification replaces the row atomically. A ''verified'' state requires evidence_ref and verified_by — the publishing payout gate''s isbn_rights_verified condition passes only on verified; absent, pending, and failed all refuse, fail-closed.';

-- ---------------------------------------------------------------------------
-- book_returns_reserve_policies: the founder-banded money terms per ISBN —
-- the share the lock lane withholds (15% to 20%) and the window the gate
-- waits (90 to 120 days). The bands are CHECK-enforced at rest here and
-- lane-enforced at write.
-- ---------------------------------------------------------------------------
create table if not exists public.book_returns_reserve_policies (
  id                    uuid primary key default gen_random_uuid(),
  isbn                  text not null,
  reserve_rate_bps      integer not null,
  reserve_window_days   integer not null,
  beneficiary_payee_id  text not null,
  beneficiary_payee_name text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (isbn),
  constraint book_returns_reserve_policies_rate_check
    check (reserve_rate_bps >= 1500 and reserve_rate_bps <= 2000),
  constraint book_returns_reserve_policies_window_check
    check (reserve_window_days >= 90 and reserve_window_days <= 120)
);

comment on table public.book_returns_reserve_policies is
  'The founder-banded returns-reserve policy of record per ISBN: reserve_rate_bps whole basis points in [1500, 2000] (15% to 20%) and reserve_window_days whole days in [90, 120]. UNIQUE (isbn): a re-registered policy replaces the row atomically (the merch sku_id precedent).';

-- ---------------------------------------------------------------------------
-- book_reserve_drawdowns: the append-only drawdown truth — the merch
-- reserve discipline (0027) at ISBN scope. Both unique constraints are
-- load-bearing: the first is the replay guard (the same return/chargeback
-- event can never draw twice); the second is the concurrent-writer
-- arbiter (the insert-as-lock position lock). The ledger FK follows the
-- 0027 discipline.
-- ---------------------------------------------------------------------------
create table if not exists public.book_reserve_drawdowns (
  id                 uuid primary key default gen_random_uuid(),
  reserve_ledger_id  text not null,
  drawdown_class     text not null,
  source_event_id    text not null,
  drawn_before_cents integer not null,
  drawn_cents        integer not null,
  remaining_cents    integer not null,
  created_at         timestamptz not null default now(),
  unique (reserve_ledger_id, source_event_id),
  unique (reserve_ledger_id, drawn_before_cents),
  constraint book_reserve_drawdowns_reserve_fk
    foreign key (reserve_ledger_id) references public.ledger_transactions (id)
    on delete cascade,
  constraint book_reserve_drawdowns_class_check
    check (drawdown_class in ('publisher_return', 'chargeback')),
  constraint book_reserve_drawdowns_before_check
    check (drawn_before_cents >= 0),
  constraint book_reserve_drawdowns_amount_check
    check (drawn_cents > 0),
  constraint book_reserve_drawdowns_remaining_check
    check (remaining_cents >= 0)
);

create index if not exists book_reserve_drawdowns_reserve_idx
  on public.book_reserve_drawdowns (reserve_ledger_id);

comment on table public.book_reserve_drawdowns is
  'The append-only returns-reserve drawdown ledger at ISBN scope: one row per (reserve credit, source return/chargeback event). UNIQUE (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE (reserve_ledger_id, drawn_before_cents) is the insert-as-lock position arbiter. The drawdown sum is the reserve''s spend — derived, never a second mutable counter.';

-- ---------------------------------------------------------------------------
-- book_return_chargebacks: the publisher return chargeback of record per
-- event_id. The chargeback's recovery splits across the two lanes below —
-- the title's held reserves and the outstanding remainder's offset against
-- incoming POD net.
-- ---------------------------------------------------------------------------
create table if not exists public.book_return_chargebacks (
  id               uuid primary key default gen_random_uuid(),
  event_id         text not null,
  isbn             text not null,
  chargeback_class text not null,
  chargeback_cents integer not null,
  currency         text not null,
  created_at       timestamptz not null default now(),
  unique (event_id),
  constraint book_return_chargebacks_class_check
    check (chargeback_class in ('publisher_return', 'chargeback')),
  constraint book_return_chargebacks_amount_check
    check (chargeback_cents > 0)
);

create index if not exists book_return_chargebacks_isbn_idx
  on public.book_return_chargebacks (isbn);

comment on table public.book_return_chargebacks is
  'The publisher return chargeback of record per event_id. UNIQUE (event_id): a re-shipped chargeback event is the counted no-op, never a double record. Recovery splits two lanes: the title''s held reserves (book_reserve_drawdowns) and the outstanding remainder''s offset against incoming POD net (book_chargeback_offset_applications).';

-- ---------------------------------------------------------------------------
-- book_chargeback_offset_applications: the append-only offset truth — the
-- publisher's recovery taken OUT of a specific held print allocation
-- BEFORE author payouts release. Both unique constraints are load-bearing:
-- the first is the replay guard (one offset application per chargeback per
-- holding), the second the concurrent-writer arbiter (the insert-as-lock
-- position lock per chargeback). Both foreign keys follow the 0027
-- ledger-child discipline.
-- ---------------------------------------------------------------------------
create table if not exists public.book_chargeback_offset_applications (
  id                  uuid primary key default gen_random_uuid(),
  chargeback_id       uuid not null,
  holding_ledger_id   text not null,
  offset_before_cents integer not null,
  applied_cents       integer not null,
  remaining_cents     integer not null,
  created_at          timestamptz not null default now(),
  unique (chargeback_id, holding_ledger_id),
  unique (chargeback_id, offset_before_cents),
  constraint book_chargeback_offset_applications_chargeback_fk
    foreign key (chargeback_id) references public.book_return_chargebacks (id)
    on delete cascade,
  constraint book_chargeback_offset_applications_holding_fk
    foreign key (holding_ledger_id) references public.ledger_transactions (id)
    on delete cascade,
  constraint book_chargeback_offset_applications_before_check
    check (offset_before_cents >= 0),
  constraint book_chargeback_offset_applications_amount_check
    check (applied_cents > 0),
  constraint book_chargeback_offset_applications_remaining_check
    check (remaining_cents >= 0)
);

create index if not exists book_chargeback_offset_applications_chargeback_idx
  on public.book_chargeback_offset_applications (chargeback_id);

comment on table public.book_chargeback_offset_applications is
  'The append-only chargeback offset ledger: one row per (chargeback, held print allocation) — the publisher''s recovery taken out of incoming POD net BEFORE author payouts release. UNIQUE (chargeback_id, holding_ledger_id) is the replay guard; UNIQUE (chargeback_id, offset_before_cents) is the insert-as-lock position arbiter.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all policies with a full service-role grant — the 0017–0030
-- precedent. Client roles read nothing; workers use the service role.
-- ---------------------------------------------------------------------------
alter table public.withholding_tax_credit_verifications enable row level security;
alter table public.isbn_rights_verifications enable row level security;
alter table public.book_returns_reserve_policies enable row level security;
alter table public.book_reserve_drawdowns enable row level security;
alter table public.book_return_chargebacks enable row level security;
alter table public.book_chargeback_offset_applications enable row level security;

drop policy if exists withholding_tax_credit_verifications_service_role_all
  on public.withholding_tax_credit_verifications;
create policy withholding_tax_credit_verifications_service_role_all
  on public.withholding_tax_credit_verifications
  for all
  using (false)
  with check (false);

drop policy if exists isbn_rights_verifications_service_role_all
  on public.isbn_rights_verifications;
create policy isbn_rights_verifications_service_role_all
  on public.isbn_rights_verifications
  for all
  using (false)
  with check (false);

drop policy if exists book_returns_reserve_policies_service_role_all
  on public.book_returns_reserve_policies;
create policy book_returns_reserve_policies_service_role_all
  on public.book_returns_reserve_policies
  for all
  using (false)
  with check (false);

drop policy if exists book_reserve_drawdowns_service_role_all
  on public.book_reserve_drawdowns;
create policy book_reserve_drawdowns_service_role_all
  on public.book_reserve_drawdowns
  for all
  using (false)
  with check (false);

drop policy if exists book_return_chargebacks_service_role_all
  on public.book_return_chargebacks;
create policy book_return_chargebacks_service_role_all
  on public.book_return_chargebacks
  for all
  using (false)
  with check (false);

drop policy if exists book_chargeback_offset_applications_service_role_all
  on public.book_chargeback_offset_applications;
create policy book_chargeback_offset_applications_service_role_all
  on public.book_chargeback_offset_applications
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.withholding_tax_credit_verifications to service_role;
grant select, insert, update, delete on public.isbn_rights_verifications to service_role;
grant select, insert, update, delete on public.book_returns_reserve_policies to service_role;
grant select, insert, update, delete on public.book_reserve_drawdowns to service_role;
grant select, insert, update, delete on public.book_return_chargebacks to service_role;
grant select, insert, update, delete on public.book_chargeback_offset_applications to service_role;

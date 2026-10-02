-- =============================================================================
-- 0030 — Book recoupment pools + editorial split schedules/accruals (PR 26)
--
-- The book/magazine lane's durable facts of record, per the founder
-- publishing directive:
--
--   book_recoupment_pools       <- upsertBookRecoupmentPool /
--                                  listBookRecoupmentPools
--     (one advance pool's running recovery — UNIQUE
--      (isbn, pool_class, sequence_no): the co-author/ghostwriter
--      contract's order of record. pool_class ISOLATES the streams:
--      'print_advance', 'ebook_advance', and
--      'audiobook_production_unrecouped' never cross-collateralize —
--      an e-book sale can never recoup a print advance. 100% of the
--      row's net flows to the open pool until advance_cents clears
--      (status flips 'active' → 'recouped' through the application
--      pass); the excess then splits per the editorial schedule.)
--   book_recoupment_applications <- insertBookRecoupmentApplication /
--                                  listBookRecoupmentApplications
--     (the append-only recovery ledger. UNIQUE per
--      (pool_id, source_event_id): a replayed application is the unique
--      violation, never a double recovery. UNIQUE per
--      (pool_id, recouped_before_cents): the POSITION lock — the
--      insert-as-lock arbiter (the PR 12/PR 99/webtoon discipline) — so
--      two concurrent applications of one pool compute the same running
--      position and exactly one wins it; the loser re-derives from the
--      append-only truth.)
--   book_editorial_split_schedules <- upsertBookEditorialSplitSchedule /
--                                     getBookEditorialSplitSchedule
--     (the split schedule of record per title_key — book scope keys the
--      title's canonical ISBN (post-advance percentage standard splits,
--      or an anthology's pro-rata with its page/word basis); magazine
--      scope keys 'magazine:{issueId}' with the issue's roster of
--      cover artists, featured columnists, senior editors, and layout
--      designers in flat-per-issue or percentage mode, configurable.)
--   book_editorial_split_accruals <- insertBookEditorialSplitAccrual /
--                                    listBookEditorialSplitAccruals
--     (the append-only accrual ledger. UNIQUE per source_event_id: a
--      replayed split is the unique violation, never a double accrual —
--      a magazine roster's flat cut accrues once per issue per schedule
--      version; subscription percentage cuts once per funding event.
--      The accrual DESIGNATES the routing; the money moves through the
--      standing release machinery (the payout gates) — the accrual row
--      is the gate's verified input.)
--
-- The money discipline: every *_cents column is an integer cent count
-- (the Don ledger's whole-cents contract); contributor cuts and
-- allocations ride jsonb (the roster is a schedule artifact, read
-- wholesale — no per-contributor table, no join fan-out on the hot
-- path).
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with a full service-role grant (the 0017–0029
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- book_recoupment_pools: one advance pool's running recovery. sequence_no
-- is the contract's recoupment order (1 = first). The UNIQUE constraint on
-- (isbn, pool_class, sequence_no) makes a re-registration converge on the
-- pool of record through the store's upsert — never a duplicate pool.
-- ---------------------------------------------------------------------------
create table if not exists public.book_recoupment_pools (
  id                   uuid primary key default gen_random_uuid(),
  isbn                 text not null,
  pool_class           text not null check (pool_class in
                         ('print_advance', 'ebook_advance',
                          'audiobook_production_unrecouped')),
  sequence_no          integer not null check (sequence_no >= 1),
  advance_cents        integer not null check (advance_cents >= 0),
  recouped_cents       integer not null default 0 check (recouped_cents >= 0),
  currency             text not null,
  status               text not null default 'active' check (status in
                         ('active', 'recouped')),
  advance_agreement_ref text not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (isbn, pool_class, sequence_no),
  check (recouped_cents <= advance_cents)
);

-- ---------------------------------------------------------------------------
-- book_recoupment_applications: the append-only recovery ledger. Both
-- unique constraints are load-bearing: the first is the replay guard (the
-- same revenue event can never recover twice); the second is the
-- concurrent-writer arbiter (the insert-as-lock position lock — exactly
-- one writer wins a pool's next running position per poll round).
-- ---------------------------------------------------------------------------
create table if not exists public.book_recoupment_applications (
  id                     uuid primary key default gen_random_uuid(),
  pool_id                uuid not null,
  pool_class             text not null check (pool_class in
                           ('print_advance', 'ebook_advance',
                            'audiobook_production_unrecouped')),
  isbn                   text not null,
  source_event_id        text not null,
  recouped_before_cents  integer not null check (recouped_before_cents >= 0),
  applied_cents          integer not null check (applied_cents >= 0),
  remaining_cents        integer not null check (remaining_cents >= 0),
  created_at             timestamptz not null default now(),
  unique (pool_id, source_event_id),
  unique (pool_id, recouped_before_cents)
);

-- ---------------------------------------------------------------------------
-- book_editorial_split_schedules: the schedule of record per title_key.
-- contributors is the jsonb roster of BookEditorialContributorSpec rows
-- (payee, role, mode, and the mode's own money/count cell). version is
-- the schedule's revision — the upsert increments it; accrued cuts keep
-- their version's event ids (history, never re-cut).
-- ---------------------------------------------------------------------------
create table if not exists public.book_editorial_split_schedules (
  id             uuid primary key default gen_random_uuid(),
  title_key      text not null,
  scope          text not null check (scope in ('book', 'magazine_issue')),
  mode           text not null check (mode in
                   ('flat_per_issue', 'percentage', 'pro_rata')),
  pro_rata_basis text check (pro_rata_basis in ('page_count', 'word_count')),
  contributors   jsonb not null,
  version        integer not null default 1 check (version >= 1),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (title_key)
);

-- ---------------------------------------------------------------------------
-- book_editorial_split_accruals: the append-only accrual ledger.
-- allocations is the jsonb array of per-payee designated shares
-- ({ payee_id, payee_name, share_cents }); dust_cents is the visible
-- sub-cent residue of a percentage cut (conservation: allocations +
-- dust = basis, exact). UNIQUE (source_event_id) is the once-only
-- guard — the unique violation IS the replay signal.
-- ---------------------------------------------------------------------------
create table if not exists public.book_editorial_split_accruals (
  id              uuid primary key default gen_random_uuid(),
  schedule_id     uuid not null,
  title_key       text not null,
  scope           text not null check (scope in ('book', 'magazine_issue')),
  source_event_id text not null,
  basis_cents     integer not null check (basis_cents >= 0),
  allocations     jsonb not null,
  dust_cents      integer not null default 0 check (dust_cents >= 0),
  created_at      timestamptz not null default now(),
  unique (source_event_id)
);

-- ---------------------------------------------------------------------------
-- RLS: deny-all policies with a full service-role grant — the 0017–0029
-- precedent. Client roles read nothing; workers use the service role.
-- ---------------------------------------------------------------------------
alter table public.book_recoupment_pools enable row level security;
alter table public.book_recoupment_applications enable row level security;
alter table public.book_editorial_split_schedules enable row level security;
alter table public.book_editorial_split_accruals enable row level security;

drop policy if exists book_recoupment_pools_service_role_all
  on public.book_recoupment_pools;
create policy book_recoupment_pools_service_role_all
  on public.book_recoupment_pools
  for all
  using (false)
  with check (false);

drop policy if exists book_recoupment_applications_service_role_all
  on public.book_recoupment_applications;
create policy book_recoupment_applications_service_role_all
  on public.book_recoupment_applications
  for all
  using (false)
  with check (false);

drop policy if exists book_editorial_split_schedules_service_role_all
  on public.book_editorial_split_schedules;
create policy book_editorial_split_schedules_service_role_all
  on public.book_editorial_split_schedules
  for all
  using (false)
  with check (false);

drop policy if exists book_editorial_split_accruals_service_role_all
  on public.book_editorial_split_accruals;
create policy book_editorial_split_accruals_service_role_all
  on public.book_editorial_split_accruals
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.book_recoupment_pools to service_role;
grant select, insert, update, delete on public.book_recoupment_applications to service_role;
grant select, insert, update, delete on public.book_editorial_split_schedules to service_role;
grant select, insert, update, delete on public.book_editorial_split_accruals to service_role;

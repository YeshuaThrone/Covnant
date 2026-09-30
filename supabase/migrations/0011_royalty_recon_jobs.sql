-- ---------------------------------------------------------------------------
-- Migration 0011 — royalty_recon_jobs (Deep Royalties recon queue, spec
-- art_7M0snhxc, build item 1).
--
-- The orchestration table the UCT layer hands work to with ONE insert: the
-- enqueue route writes a pending row and returns 202 — no parsing, no model
-- calls, no outbound fetch in a request cycle. Parsed line items stay in the
-- EXISTING match_queue (the locked decision — never a parallel table).
--
-- House pattern (0006/0010): check-constrained status, RLS deny-all, full
-- service_role grant, insertion_order bigint. This file is idempotent —
-- CI applies it twice; every object uses IF NOT EXISTS / OR REPLACE.
-- ---------------------------------------------------------------------------

create table if not exists public.royalty_recon_jobs (
  id              uuid primary key default gen_random_uuid(),
  status          text not null default 'pending'
                  check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  source          text not null,
  -- statement_ingests.id is TEXT (0007; the store mints randomUUID() into
  -- it) — the FK must match the referenced column's type exactly.
  ingest_id       text references public.statement_ingests (id),
  requested_by    uuid,
  engine          text,
  attempts        int not null default 0,
  error           text,
  result          jsonb,
  claimed_at      timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  insertion_order bigint generated always as identity
);

comment on table public.royalty_recon_jobs is
  'Deep Royalties recon orchestration queue: UCT enqueues (one INSERT, 202), the CVT worker claims and completes. Parsed line items live in match_queue, never here.';
comment on column public.royalty_recon_jobs.status is
  'Job lifecycle — values pending, processing, completed, failed, cancelled. Crash recovery is the claim query: stale processing claims older than 30 minutes re-enter the pool.';
comment on column public.royalty_recon_jobs.source is
  'The statement_ingests.source vocabulary (statement, manual) — migration 0007, reused verbatim.';
comment on column public.royalty_recon_jobs.ingest_id is
  'Optional statement_ingests provenance to re-parse. statement_ingests carries no creator linkage column, so ingest-scoped jobs are operator-authenticated (the enqueue route enforces this).';
comment on column public.royalty_recon_jobs.requested_by is
  'The requesting creator_profiles id; null = operator job.';
comment on column public.royalty_recon_jobs.engine is
  'Resolved at claim; null = deterministic parse only (zero model tokens).';
comment on column public.royalty_recon_jobs.attempts is
  'Incremented on every claim. The retry budget is attempts < 3; the worker''s failReconJob makes failure terminal past the cap.';

-- The claim query's scan: pool candidates by lifecycle, oldest first.
create index if not exists idx_recon_jobs_status
  on public.royalty_recon_jobs (status, created_at);

-- ---------------------------------------------------------------------------
-- The claim RPC — the settlement concurrency canon (0009): FOR UPDATE SKIP
-- LOCKED so concurrent workers serialize on the pool, stale-claim recovery
-- built into the candidate filter (a processing claim older than 30 minutes
-- is re-claimable — a crashed worker's job re-enters the pool), attempts
-- incremented on the same statement that hands the job out. Returns the
-- claimed job as jsonb, or null when the pool is empty.
-- ---------------------------------------------------------------------------
create or replace function public.claim_royalty_recon_job(
  p_now    timestamptz default now(),
  p_engine text        default null
)
returns jsonb
language sql
set search_path = public
as $$
  update public.royalty_recon_jobs
  set status = 'processing',
      engine = p_engine,
      claimed_at = p_now,
      started_at = coalesce(started_at, p_now),
      attempts = attempts + 1,
      updated_at = p_now
  where id = (
    select id from public.royalty_recon_jobs
    where status = 'pending'
       or (status = 'processing' and claimed_at < p_now - interval '30 minutes')
    order by created_at
    for update skip locked
    limit 1
  )
  returning to_jsonb(royalty_recon_jobs);
$$;

-- ---------------------------------------------------------------------------
-- Rights-type separation (V1 directive addendum, 2026-09-30): line items must
-- be explicitly tagged MASTER vs PUBLISHING so split calculations never
-- conflate recording royalties with composition royalties. The canonical
-- `rights_pipeline` (composition_mechanical, master_interactive, ...) records
-- usage kind and is NOT the rights family — the tag is explicit, never
-- derived. Vocabulary matches the house lowercase convention; the directive's
-- MASTER/PUBLISHING map to 'master'/'publishing'. Quarantine rule: 'unknown'
-- rows are excluded from split math until reclassified — the default
-- quarantines unclassified ingests instead of guessing.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists rights_type text not null default 'unknown';

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_rights_type_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_rights_type_check
      check (rights_type in ('master', 'publishing', 'unknown'));
  end if;
end $$;

create index if not exists match_queue_rights_type_idx
  on public.match_queue (rights_type);

comment on column public.match_queue.rights_type is
  'Rights family for the line item — values master, publishing, unknown. Quarantine rule: unknown rows are excluded from split math until reclassified (never guessed from rights_pipeline). Added by the V1 rights-separation directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Film waterfall (V1 directive addendum 2, 2026-09-30): sequential tier-level
-- ordering for film waterfall ingestion and a statement-kind tag. tier_level
-- is the waterfall tier (0 through 5); null rides the non-waterfall default
-- lane. statement_source_type distinguishes VOD and SVOD statements,
-- theatrical box office reports, and international sales agent statements —
-- the existing 17 columns cannot (source is ingress webhook/statement/
-- api_pull, rights_pipeline carries only the four music/DSP pipelines, and
-- platform is free-form per-event display data). Null statement_source_type
-- means not classified (the music lane). Relaxing either bound is a one-line
-- additive migration if the waterfall engine needs more vocabulary.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists tier_level int;

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_tier_level_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_tier_level_check
      check (tier_level between 0 and 5);
  end if;
end $$;

alter table public.match_queue
  add column if not exists statement_source_type text;

do $$
begin
  if exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_statement_source_type_check'
      and pg_get_constraintdef(oid) not like '%game_platform%'
  ) then
    alter table public.match_queue
      drop constraint match_queue_statement_source_type_check;
  end if;
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_statement_source_type_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_statement_source_type_check
      check (statement_source_type in ('vod', 'svod', 'theatrical_box_office', 'international_sales_agent', 'game_platform', 'livestream'));
  end if;
end $$;

create index if not exists match_queue_tier_level_idx
  on public.match_queue (tier_level, insertion_order);

comment on column public.match_queue.tier_level is
  'Film waterfall tier, 0 through 5 — null rides the non-waterfall default lane. Added by the V1 film-waterfall directive addendum (2026-09-30).';
comment on column public.match_queue.statement_source_type is
  'Statement kind for film-waterfall ingestion — values vod, svod, theatrical_box_office, international_sales_agent; null = not classified (music lane). Added by the V1 film-waterfall directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Podcast vertical (V1 directive addendum 3, 2026-09-30): DAI and RSS
-- ingestion. revenue_channel carries the revenue lane — channel_a_dai
-- (programmatic), channel_b_host_read (sponsor and affiliate),
-- channel_c_subscription (membership); null = non-podcast lines. ad_slot is
-- the pod position for ad lines (pre_roll, mid_roll, post_roll); null for
-- non-ad lines. verified_impressions is the ad-verified count (non-negative;
-- null when unverified or non-ad). network_sold marks network-sold inventory
-- (null = unknown or not applicable). All four are nullable — the podcast
-- IAB engine populates them; relaxing a vocabulary is a one-line additive
-- migration.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists revenue_channel text;

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_revenue_channel_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_revenue_channel_check
      check (revenue_channel in ('channel_a_dai', 'channel_b_host_read', 'channel_c_subscription'));
  end if;
end $$;

alter table public.match_queue
  add column if not exists ad_slot text;

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_ad_slot_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_ad_slot_check
      check (ad_slot in ('pre_roll', 'mid_roll', 'post_roll'));
  end if;
end $$;

alter table public.match_queue
  add column if not exists verified_impressions int;

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_verified_impressions_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_verified_impressions_check
      check (verified_impressions >= 0);
  end if;
end $$;

alter table public.match_queue
  add column if not exists network_sold boolean;

comment on column public.match_queue.revenue_channel is
  'Podcast revenue lane — values channel_a_dai (programmatic), channel_b_host_read (sponsor and affiliate), channel_c_subscription (membership); null = non-podcast lines. Added by the V1 podcast directive addendum (2026-09-30).';
comment on column public.match_queue.ad_slot is
  'Pod position for ad lines — values pre_roll, mid_roll, post_roll; null for non-ad lines. Added by the V1 podcast directive addendum (2026-09-30).';
comment on column public.match_queue.verified_impressions is
  'Ad-verified impression count (non-negative); null when unverified or non-ad. Added by the V1 podcast directive addendum (2026-09-30).';
comment on column public.match_queue.network_sold is
  'Network-sold inventory flag; null = unknown or not applicable. Added by the V1 podcast directive addendum (2026-09-30).';


-- ---------------------------------------------------------------------------
-- Gaming vertical (V1 directive addendum 4, 2026-09-30): game platform
-- revenue. sale_type separates primary sales from secondary resale.
-- virtual_currency_code / virtual_amount / exchange_rate carry the
-- virtual-currency legs (Robux, V-Bucks, Coins, ...) — all three null for
-- fiat lines; virtual amounts and rates are exact decimals as text, the
-- table's fixed-point convention (never a float). engine_royalty_micros and
-- platform_commission_micros follow the gross_micros convention: fixed-point
-- micros as text. Game-platform statements carry statement_source_type =
-- 'game_platform' (see the film block); which platform rides the existing
-- free-text `platform` column. The gaming fee parser and DevEx converter
-- populate these; vocabularies relax via one-line additive migrations.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists sale_type text;

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_sale_type_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_sale_type_check
      check (sale_type in ('primary', 'secondary_resale'));
  end if;
end $$;

alter table public.match_queue
  add column if not exists virtual_currency_code text;

alter table public.match_queue
  add column if not exists virtual_amount text;

alter table public.match_queue
  add column if not exists exchange_rate text;

alter table public.match_queue
  add column if not exists engine_royalty_micros text;

alter table public.match_queue
  add column if not exists platform_commission_micros text;

comment on column public.match_queue.sale_type is
  'Game-platform sale type — values primary, secondary_resale; null = not applicable (non-game lines). Added by the V1 gaming directive addendum (2026-09-30).';
comment on column public.match_queue.virtual_currency_code is
  'Platform virtual-currency denomination (Robux, V-Bucks, Coins, ...); null for fiat lines. Added by the V1 gaming directive addendum (2026-09-30).';
comment on column public.match_queue.virtual_amount is
  'Exact virtual amount as decimal text — never a float; null for fiat lines. Added by the V1 gaming directive addendum (2026-09-30).';
comment on column public.match_queue.exchange_rate is
  'Fiat-per-virtual-unit exchange rate as exact decimal text; null for fiat lines. Added by the V1 gaming directive addendum (2026-09-30).';
comment on column public.match_queue.engine_royalty_micros is
  'Engine royalty, fixed-point micros as text — never a float; null when none. Added by the V1 gaming directive addendum (2026-09-30).';
comment on column public.match_queue.platform_commission_micros is
  'Platform commission, fixed-point micros as text — never a float; null when none. Added by the V1 gaming directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Derivative inheritance + livestream/esports (V1 directive addendum 5,
-- 2026-09-30). parent_asset_id points a derivative micro-item or mod at the
-- upstream cbt_assets row it builds on — the cascade allocator distributes
-- royalties upstream-first before downstream net (locked rule). Livestream
-- lines: stream_platform distinguishes the six stream sources; alert_type +
-- revenue_basis carry sponsor overlay economics (flat or CPM);
-- prize_pool_batch groups esports waterfall lines into their prize pool —
-- the waterfall STEPS reuse tier_level (same sequential-recoupment ordering
-- concept as film; relaxing the 0-5 bound is the documented one-line
-- migration if esports needs deeper tiers).
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists parent_asset_id uuid references public.cbt_assets (id);

alter table public.match_queue
  add column if not exists stream_platform text;

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_stream_platform_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_stream_platform_check
      check (stream_platform in ('twitch', 'youtube_live', 'kick', 'tiktok_live', 'streamlabs', 'streamelements'));
  end if;
end $$;

alter table public.match_queue
  add column if not exists alert_type text;

alter table public.match_queue
  add column if not exists revenue_basis text;

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_revenue_basis_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_revenue_basis_check
      check (revenue_basis in ('flat', 'cpm'));
  end if;
end $$;

alter table public.match_queue
  add column if not exists prize_pool_batch text;

comment on column public.match_queue.parent_asset_id is
  'Upstream cbt_assets row a derivative item or mod builds on; null = original work. The cascade allocator walks it upstream-first. Added by the V1 derivative directive addendum (2026-09-30).';
comment on column public.match_queue.stream_platform is
  'Stream source for livestream lines — values twitch, youtube_live, kick, tiktok_live, streamlabs, streamelements; null = non-livestream. Added by the V1 livestream directive addendum (2026-09-30).';
comment on column public.match_queue.alert_type is
  'Sponsor overlay alert type (donation, subscription, follow, ...); null = no alert context. Added by the V1 livestream directive addendum (2026-09-30).';
comment on column public.match_queue.revenue_basis is
  'Sponsor payout basis — values flat, cpm; null when not sponsorship lines. Added by the V1 livestream directive addendum (2026-09-30).';
comment on column public.match_queue.prize_pool_batch is
  'Esports prize-pool batch grouping waterfall lines; steps reuse tier_level. Added by the V1 esports directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Music dependency + film tax + podcast feed mapping (V1 directive
-- addendum 6, 2026-09-30). parent_composition_id tracks sample and
-- interpolation dependencies — the upstream COMPOSITION a derivative
-- recording builds on (distinct from parent_asset_id, the upstream asset
-- for derivative micro-items and mods); both walk cbt_assets for upstream-
-- first distribution. is_cover_version carries the HFA/MLC statutory cover
-- flag. territory_code + foreign_tax_withheld give film lines their
-- territory-level tax handling — the code is the withholding jurisdiction,
-- separate from the free-form market `territory`. rss_feed_id maps podcast
-- lines to their feed. ad_placement_type stands alone: it is the DELIVERY
-- method (host_read, dai) and can diverge from the revenue lane in
-- revenue_channel (host-read copy served through DAI insertion), so it is
-- a separate nullable column, not a refinement of that enum.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists parent_composition_id uuid references public.cbt_assets (id);

alter table public.match_queue
  add column if not exists is_cover_version boolean;

alter table public.match_queue
  add column if not exists territory_code text;

alter table public.match_queue
  add column if not exists foreign_tax_withheld boolean;

alter table public.match_queue
  add column if not exists rss_feed_id text;

alter table public.match_queue
  add column if not exists ad_placement_type text;

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_ad_placement_type_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_ad_placement_type_check
      check (ad_placement_type in ('host_read', 'dai'));
  end if;
end $$;

comment on column public.match_queue.parent_composition_id is
  'Upstream cbt_assets composition a sample or interpolation builds on; null = original work. Distinct from parent_asset_id (the derivative-asset parent). Added by the V1 music dependency directive addendum (2026-09-30).';
comment on column public.match_queue.is_cover_version is
  'HFA/MLC statutory cover flag; null = not classified. Added by the V1 music dependency directive addendum (2026-09-30).';
comment on column public.match_queue.territory_code is
  'Withholding jurisdiction for territory-level film tax handling; separate from the free-form market territory. Added by the V1 film tax directive addendum (2026-09-30).';
comment on column public.match_queue.foreign_tax_withheld is
  'Whether foreign tax was withheld on the line; null = unknown. Added by the V1 film tax directive addendum (2026-09-30).';
comment on column public.match_queue.rss_feed_id is
  'Podcast feed the line maps to; null = not feed-scoped. Added by the V1 podcast feed directive addendum (2026-09-30).';
comment on column public.match_queue.ad_placement_type is
  'Ad delivery method — values host_read, dai; independent of the revenue_channel lane (host-read copy can be served through DAI). Added by the V1 podcast feed directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Publishing / webtoon vertical (V1 directive addendum 7, 2026-09-30).
-- format_type maps the publication format a line was earned in — print,
-- digital chapter, coin unlock, KENP page-read, audio. language_code
-- isolates per-language feeds so the same title in different languages
-- reconciles separately. Webtoon Coins and Tapas Ink ride the EXISTING
-- virtual-currency columns (virtual_currency_code / virtual_amount /
-- exchange_rate) from the gaming addendum — deliberately not duplicated
-- here.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists format_type text;

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.match_queue'::regclass
      and conname = 'match_queue_format_type_check'
  ) then
    alter table public.match_queue
      add constraint match_queue_format_type_check
      check (format_type in ('print', 'digital_chapter', 'coin_unlock', 'kenp_page_read', 'audio'));
  end if;
end $$;

alter table public.match_queue
  add column if not exists language_code text;

comment on column public.match_queue.format_type is
  'Publication format — values print, digital_chapter, coin_unlock, kenp_page_read, audio; null = not classified. Added by the V1 publishing directive addendum (2026-09-30).';
comment on column public.match_queue.language_code is
  'Per-language feed isolation code; null = not language-scoped. Added by the V1 publishing directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Merch and AI metering (V1 directive addendum 8, 2026-09-30). sku_id
-- maps a physical-merch line to its inventory SKU; cogs_per_unit_micros
-- carries the per-unit cost of goods for FIFO amortization — named for
-- the table's money convention (fixed-point micros as text, like
-- gross_micros and the gaming fee columns), never a float. usage_unit +
-- usage_quantity carry AI metering (tokens, characters, minutes) — the
-- unit is free-form because platform vocabularies proliferate, and the
-- quantity is exact decimal as text so billing math stays exact.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists sku_id text;

alter table public.match_queue
  add column if not exists cogs_per_unit_micros text;

alter table public.match_queue
  add column if not exists usage_unit text;

alter table public.match_queue
  add column if not exists usage_quantity text;

comment on column public.match_queue.sku_id is
  'Physical inventory SKU the merch line maps to; null = non-merch lines. Added by the V1 merch directive addendum (2026-09-30).';
comment on column public.match_queue.cogs_per_unit_micros is
  'Per-unit cost of goods for FIFO amortization, fixed-point micros as text — never a float; null when not applicable. Added by the V1 merch directive addendum (2026-09-30).';
comment on column public.match_queue.usage_unit is
  'AI metering unit — tokens, characters, minutes, ...; null = non-metered lines. Added by the V1 AI directive addendum (2026-09-30).';
comment on column public.match_queue.usage_quantity is
  'Metered usage amount as exact decimal text — never a float; null when not metered. Added by the V1 AI directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Books and AI attribution (V1 directive addendum 9, 2026-09-30). isbn
-- maps a line to its book title. country_code isolates publishing
-- localization — deliberately SEPARATE from territory_code (addendum 6):
-- territory_code is the film tax-withholding jurisdiction, while the
-- publishing localization market is a different concern filled by a
-- different parser; overloading one column would couple the two verticals
-- semantics. ai_model_id + dataset_attribution_weight carry fractional AI
-- inference attribution — the weight is exact decimal as text (the table
-- fixed-point convention, never a float).
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists isbn text;

alter table public.match_queue
  add column if not exists country_code text;

alter table public.match_queue
  add column if not exists ai_model_id text;

alter table public.match_queue
  add column if not exists dataset_attribution_weight text;

comment on column public.match_queue.isbn is
  'ISBN-13 (or legacy ISBN-10 normalized by the parser) of the book title; null = non-book lines. Added by the V1 book directive addendum (2026-09-30).';
comment on column public.match_queue.country_code is
  'Publishing localization market — separate from territory_code (the film tax jurisdiction). Added by the V1 book directive addendum (2026-09-30).';
comment on column public.match_queue.ai_model_id is
  'AI model whose inference produced the line; null = non-AI lines. Added by the V1 AI attribution directive addendum (2026-09-30).';
comment on column public.match_queue.dataset_attribution_weight is
  'Fractional dataset-attribution weight as exact decimal text — never a float; null when not attributed. Added by the V1 AI attribution directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Art market (V1 directive addendum 10, 2026-09-30). artwork_id maps a
-- line to the art object; provenance_hash anchors the line to the
-- provenance chain for verification; jurisdiction_code carries the
-- cross-border RESALE-right jurisdiction — deliberately separate from
-- territory_code (film tax withholding) and country_code (publishing
-- localization): three verticals, three legal semantics, three columns.
-- The artist-estate flag is ENTITY-level, not line-level — it ALTERs
-- creator_profiles below (is_artist_estate / estate_succession_verified),
-- where the art payout gate reads the succession state fail-closed.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists artwork_id text;

alter table public.match_queue
  add column if not exists provenance_hash text;

alter table public.match_queue
  add column if not exists jurisdiction_code text;

comment on column public.match_queue.artwork_id is
  'Art object the line maps to; null = non-art lines. Added by the V1 art directive addendum (2026-09-30).';
comment on column public.match_queue.provenance_hash is
  'Provenance-chain hash anchoring the line for verification; null = not provenance-anchored. Added by the V1 art directive addendum (2026-09-30).';
comment on column public.match_queue.jurisdiction_code is
  'Cross-border resale-right jurisdiction — separate from territory_code (film tax) and country_code (publishing localization). Added by the V1 art directive addendum (2026-09-30).';

-- Artist-estate state: ENTITY-level on creator_profiles (0003), deliberately
-- not on match_queue lines. The art payout gate reads
-- estate_succession_verified fail-closed — null counts as unverified,
-- never as verified.
alter table public.creator_profiles
  add column if not exists is_artist_estate boolean;

alter table public.creator_profiles
  add column if not exists estate_succession_verified boolean;

comment on column public.creator_profiles.is_artist_estate is
  'Whether this creator entity is an artist''s estate; null = not assessed. Added by the V1 art directive addendum (2026-09-30).';
comment on column public.creator_profiles.estate_succession_verified is
  'Estate-succession verification state the art payout gate reads — fail-closed: null counts as unverified. Added by the V1 art directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Live theater and comedy (V1 directive addendum 11, 2026-09-30).
-- production_id and venue_id map a line to the production and the venue;
-- show_date carries the performance date as an ISO date string (the
-- store's text timestamp convention). RIGHTS-TYPE JUDGMENT: rights_type
-- keeps its three-value rights family (master/publishing/unknown) — a
-- Grand Rights line is publishing-family, and folding a licensing
-- sub-category into the rights family would break the split-quarantine
-- contract. The theatrical routing value rides a separate license_class
-- column below; the Grand Rights vs small rights ROUTING RULE itself
-- ships in allocator PRs 30 and 31.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists production_id text;

alter table public.match_queue
  add column if not exists venue_id text;

alter table public.match_queue
  add column if not exists show_date text;

alter table public.match_queue
  add column if not exists license_class text;

do $$
begin
  alter table public.match_queue add constraint match_queue_license_class_check
    check (license_class is null or license_class in ('grand_rights', 'small_rights'));
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_match_queue_show_date
  on public.match_queue (show_date);

comment on column public.match_queue.production_id is
  'Live production the line maps to; null = non-theatrical lines. Added by the V1 theater directive addendum (2026-09-30).';
comment on column public.match_queue.venue_id is
  'Venue the performance ran at; null = non-theatrical lines. Added by the V1 theater directive addendum (2026-09-30).';
comment on column public.match_queue.show_date is
  'Performance date as an ISO date string; null = non-performance lines. Added by the V1 theater directive addendum (2026-09-30).';
comment on column public.match_queue.license_class is
  'Grand Rights vs small rights routing class — the routing rule itself ships in allocator PRs 30/31; null = not classified. Added by the V1 theater directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Brand licensing (V1 directive addendum 12, 2026-09-30). license_id
-- maps a line to the license agreement it falls under; category_code
-- carries the licensed product category. TERRITORY JUDGMENT:
-- territory_iso stands SEPARATE from territory_code (film tax
-- withholding), country_code (publishing localization), and
-- jurisdiction_code (art resale rights) — a license's territorial grant
-- scope is a contractual concept, the fourth distinct territory-ish
-- semantic; one vertical, one legal semantic, one column.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists license_id text;

alter table public.match_queue
  add column if not exists category_code text;

alter table public.match_queue
  add column if not exists territory_iso text;

comment on column public.match_queue.license_id is
  'License agreement the line falls under; null = non-licensed lines. Added by the V1 brand-licensing directive addendum (2026-09-30).';
comment on column public.match_queue.category_code is
  'Licensed product category; null = unclassified lines. Added by the V1 brand-licensing directive addendum (2026-09-30).';
comment on column public.match_queue.territory_iso is
  'License territorial grant scope — separate from territory_code (film tax), country_code (publishing localization), and jurisdiction_code (art resale). Added by the V1 brand-licensing directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- NIL (name, image, likeness) (V1 directive addendum 13, 2026-09-30).
-- athlete_id maps a line to the athlete; school_id to their program.
-- JURISDICTION JUDGMENT: state_jurisdiction_code stands SEPARATE from
-- jurisdiction_code (art cross-border resale): NIL compliance runs on US
-- state statutes — a different legal regime, filler, and vertical. The
-- one-vertical-one-semantic-one-column rule now covers five territory-ish
-- columns (territory_code, country_code, jurisdiction_code,
-- territory_iso, state_jurisdiction_code).
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists athlete_id text;

alter table public.match_queue
  add column if not exists school_id text;

alter table public.match_queue
  add column if not exists state_jurisdiction_code text;

comment on column public.match_queue.athlete_id is
  'Athlete the NIL line maps to; null = non-NIL lines. Added by the V1 NIL directive addendum (2026-09-30).';
comment on column public.match_queue.school_id is
  'Athletic program (school) the NIL line maps to; null = non-NIL lines. Added by the V1 NIL directive addendum (2026-09-30).';
comment on column public.match_queue.state_jurisdiction_code is
  'US state whose NIL statute governs the line — separate from jurisdiction_code (art resale). Added by the V1 NIL directive addendum (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Spatial / location-based entertainment (V1 directive addendum 14 +
-- founder patch, 2026-09-30). venue_id already exists (addendum 11);
-- these two founder-named columns locate the line WITHIN the venue.
-- zone_code is the founder-specified name (supersedes the zone_id
-- judgment call); spatial_footprint_sqft carries the zone footprint as
-- exact-decimal text per the table's fixed-point convention.
-- JUDGMENT (reported): throughput counters stay payload-side — they are
-- time-series telemetry, not line-level classification, so raw_payload
-- carries them. Beacon/RFID hardware identifiers ride identifiers_json.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists zone_code text;

alter table public.match_queue
  add column if not exists spatial_footprint_sqft text;

comment on column public.match_queue.zone_code is
  'Spatial zone within the venue (founder-patched name); null = non-spatial lines. Added by the V1 spatial directive (2026-09-30).';
comment on column public.match_queue.spatial_footprint_sqft is
  'Zone footprint in square feet, exact-decimal text; null = non-spatial lines. Added by the V1 spatial directive (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Fitness / connected-wellness vertical (V1 directive addendum 15 +
-- founder patch, 2026-09-30). trainer_id and program_id key workout IP;
-- studio_franchise_code is the founder-patched boutique franchise
-- location code (the patch supersedes the payload-side judgment for the
-- franchise code specifically).
-- JUDGMENT (reported): wearable device IDs ride identifiers_json — device
-- hardware ids are identifiers, the same lane as the spatial beacon/RFID
-- choice. Residual agreement-level context (rate cards, exclusivity
-- terms) stays payload-side in raw_payload.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists trainer_id text;

alter table public.match_queue
  add column if not exists program_id text;

alter table public.match_queue
  add column if not exists studio_franchise_code text;

comment on column public.match_queue.trainer_id is
  'Workout IP trainer for fitness streams and class check-ins; null = non-fitness lines. Added by the V1 fitness directive (2026-09-30).';
comment on column public.match_queue.program_id is
  'Fitness program (module-weighted waterfall key); null = non-fitness lines. Added by the V1 fitness directive (2026-09-30).';
comment on column public.match_queue.studio_franchise_code is
  'Boutique franchise location code (founder-patched); null = non-franchise lines. Added by the V1 fitness directive (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Culinary / ghost-kitchen vertical (V1 directive addendum 16,
-- 2026-09-30, founder-specified). chef_id and recipe_id key recipe IP;
-- ghost_kitchen_location_id tracks the producing kitchen.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists chef_id text;

alter table public.match_queue
  add column if not exists recipe_id text;

alter table public.match_queue
  add column if not exists ghost_kitchen_location_id text;

comment on column public.match_queue.chef_id is
  'Recipe IP chef for culinary streams and ghost-kitchen lines; null = non-culinary lines. Added by the V1 culinary directive (2026-09-30).';
comment on column public.match_queue.recipe_id is
  'Licensed recipe for culinary royalty lines; null = non-culinary lines. Added by the V1 culinary directive (2026-09-30).';
comment on column public.match_queue.ghost_kitchen_location_id is
  'Producing ghost-kitchen location; null = non-culinary lines. Added by the V1 culinary directive (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Salon / med-spa / hospitality franchise vertical (V1 directive
-- addendum 17 + founder patch, 2026-09-30). stylist_id, protocol_id, and
-- salon_location_id key service IP on the line (founder-patched names,
-- replacing the addendum-17 technician/franchise-location/treatment names
-- before the migration ever merged).
-- JUDGMENT (reported): membership account identifiers stay payload-side —
-- they are buyer-entity context, not line-level royalty classification,
-- and ride identifiers_json/raw_payload. Backbar product SKUs also stay
-- payload-side: service-delivery consumables are cost context for the
-- supplier-rebate engine, and reusing retail's sku_id (addendum 8) would
-- conflate sale mapping with consumption.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists stylist_id text;

alter table public.match_queue
  add column if not exists salon_location_id text;

alter table public.match_queue
  add column if not exists protocol_id text;

comment on column public.match_queue.stylist_id is
  'Service IP stylist for salon and med-spa lines; null = non-service lines. Added by the V1 salon directive (2026-09-30).';
comment on column public.match_queue.salon_location_id is
  'Hospitality or salon franchise location; null = non-franchise lines. Added by the V1 salon directive (2026-09-30).';
comment on column public.match_queue.protocol_id is
  'Licensed treatment protocol (service IP) for med-spa lines; null = non-service lines. Added by the V1 salon directive (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Developer tools vertical (V1 directive addendum 18, 2026-09-30,
-- founder-specified). developer_id keys software IP; api_endpoint_id
-- maps metered API usage; sdk_package_hash identifies the distributed
-- package build.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists developer_id text;

alter table public.match_queue
  add column if not exists api_endpoint_id text;

alter table public.match_queue
  add column if not exists sdk_package_hash text;

comment on column public.match_queue.developer_id is
  'Software IP developer for dev-tool royalty lines; null = non-developer lines. Added by the V1 developer-tools directive (2026-09-30).';
comment on column public.match_queue.api_endpoint_id is
  'Metered API endpoint reference; null = non-API lines. Added by the V1 developer-tools directive (2026-09-30).';
comment on column public.match_queue.sdk_package_hash is
  'Distributed SDK package build hash; null = non-package lines. Added by the V1 developer-tools directive (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Hardware patent vertical (V1 directive addendum 19, 2026-09-30,
-- founder-specified). patent_family_id keys the licensed family;
-- sep_pool_code identifies the standard-essential pool;
-- device_imei_mac carries the device-level hardware identifier.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists patent_family_id text;

alter table public.match_queue
  add column if not exists sep_pool_code text;

alter table public.match_queue
  add column if not exists device_imei_mac text;

comment on column public.match_queue.patent_family_id is
  'Licensed hardware patent family; null = non-patent lines. Added by the V1 hardware-patent directive (2026-09-30).';
comment on column public.match_queue.sep_pool_code is
  'Standard-essential patent pool code; null = non-pool lines. Added by the V1 hardware-patent directive (2026-09-30).';
comment on column public.match_queue.device_imei_mac is
  'Device-level IMEI or MAC identifier; null = non-device lines. Added by the V1 hardware-patent directive (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Energy and resource vertical (V1 directive addendum 20, 2026-09-30,
-- founder-specified). parcel_id keys the land parcel; well_meter_id
-- carries the producing meter; gpu_cluster_hash identifies the compute
-- cluster for GPU-hosting royalty lines.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists parcel_id text;

alter table public.match_queue
  add column if not exists well_meter_id text;

alter table public.match_queue
  add column if not exists gpu_cluster_hash text;

comment on column public.match_queue.parcel_id is
  'Land or resource parcel for energy royalty lines; null = non-resource lines. Added by the V1 energy directive (2026-09-30).';
comment on column public.match_queue.well_meter_id is
  'Producing well or meter identifier; null = non-resource lines. Added by the V1 energy directive (2026-09-30).';
comment on column public.match_queue.gpu_cluster_hash is
  'Compute cluster identifier for GPU-hosting lines; null = non-compute lines. Added by the V1 energy directive (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Sports ticketing vertical (V1 directive addendum 21, 2026-09-30,
-- founder-specified). nil_contract_id ties lines to the endorsement;
-- athlete_glan and venue_gln carry the GLN identifiers; league_rights_code
-- keys league-broadcast and group-licensing rights; turnstile_scan_hash
-- anchors gate-reconciliation to scan telemetry.
-- ---------------------------------------------------------------------------
alter table public.match_queue
  add column if not exists nil_contract_id text;

alter table public.match_queue
  add column if not exists athlete_glan text;

alter table public.match_queue
  add column if not exists venue_gln text;

alter table public.match_queue
  add column if not exists league_rights_code text;

alter table public.match_queue
  add column if not exists turnstile_scan_hash text;

comment on column public.match_queue.nil_contract_id is
  'NIL endorsement contract reference; null = non-NIL lines. Added by the V1 sports-ticketing directive (2026-09-30).';
comment on column public.match_queue.athlete_glan is
  'Athlete Global Location Number; null = non-athlete lines. Added by the V1 sports-ticketing directive (2026-09-30).';
comment on column public.match_queue.venue_gln is
  'Venue Global Location Number; null = non-venue lines. Added by the V1 sports-ticketing directive (2026-09-30).';
comment on column public.match_queue.league_rights_code is
  'League broadcasting and group-licensing rights code; null = non-league lines. Added by the V1 sports-ticketing directive (2026-09-30).';
comment on column public.match_queue.turnstile_scan_hash is
  'Turnstile scan telemetry hash for gate reconciliation; null = non-gate lines. Added by the V1 sports-ticketing directive (2026-09-30).';

-- ---------------------------------------------------------------------------
-- Universal identifier layer — addenda 22-27, extended by canon v10
-- (addendum 29), V1 directive 2026-09-30. Resolution columns on match_queue plus a cross-code mapping
-- table over the twenty-one-chain identifier canon. Canon v9 (addendum 28)
-- adds no schema — the ~48 validation regexes are engine-side constants for
-- the PR 52 validation engine. Code types are founder-specified verbatim.
-- ---------------------------------------------------------------------------

alter table public.match_queue
  add column if not exists resolved_chain text
  check (resolved_chain in ('music', 'sports', 'film', 'fine_art', 'spatial', 'fitness_health', 'culinary', 'wellness', 'dev_infra', 'patent', 'energy', 'podcasting', 'gaming', 'livestream', 'fashion', 'ai_data', 'theater', 'brand_licensing', 'web_comics', 'corporate', 'salon_beauty'));
alter table public.match_queue
  add column if not exists resolved_identifiers jsonb;
alter table public.match_queue
  add column if not exists unclaimed_identifier_hold boolean not null default false;
alter table public.match_queue
  add column if not exists identifier_hold_reason text;

-- Holds surface oldest-first for the verification queue.
create index if not exists idx_match_queue_unclaimed_identifier_hold
  on public.match_queue (created_at)
  where unclaimed_identifier_hold;

comment on column public.match_queue.resolved_chain is
  'Canonical chain the identifiers resolved to (music, sports, film, fine_art, spatial, fitness_health, culinary, wellness, dev_infra, patent, energy, podcasting, gaming, livestream, fashion, ai_data, theater, brand_licensing, web_comics, corporate, salon_beauty). Added by the V1 universal-identifier directive (2026-09-30).';
comment on column public.match_queue.resolved_identifiers is
  'Resolved identifier set: [{code_type, code_value, source}] spanning the identifier canon; null = unresolved. Added by the V1 universal-identifier directive (2026-09-30).';
comment on column public.match_queue.unclaimed_identifier_hold is
  'True when no canonical identifier claims the line — quarantined pending external registry verification, never auto-discarded. Added by the V1 universal-identifier directive (2026-09-30).';
comment on column public.match_queue.identifier_hold_reason is
  'Named hold reason (e.g. registry unreachable, ambiguous chain); null = no hold. Added by the V1 universal-identifier directive (2026-09-30).';

create table if not exists public.identifier_cross_mappings (
  id uuid primary key default gen_random_uuid(),
  chain text not null check (chain in ('music', 'sports', 'film', 'fine_art', 'spatial', 'fitness_health', 'culinary', 'wellness', 'dev_infra', 'patent', 'energy', 'podcasting', 'gaming', 'livestream', 'fashion', 'ai_data', 'theater', 'brand_licensing', 'web_comics', 'corporate', 'salon_beauty')),
  source_code_type text not null,
  source_code_value text not null,
  target_code_type text not null,
  target_code_value text not null,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  insertion_order bigint
);

-- The founder directive names the chains and their member code types
-- verbatim; the composite check enforces exactly these memberships.
-- Named constraints have no IF NOT EXISTS — guard the re-apply so the
-- migration stays idempotent.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'identifier_cross_mappings_chain_vocab'
      and conrelid = 'public.identifier_cross_mappings'::regclass
  ) then
    alter table public.identifier_cross_mappings
      add constraint identifier_cross_mappings_chain_vocab check (
    (chain = 'music' and source_code_type in ('ISRC', 'ISWC', 'IPI', 'ISNI', 'MWLI')
      and target_code_type in ('ISRC', 'ISWC', 'IPI', 'ISNI', 'MWLI')) or
    (chain = 'sports' and source_code_type in ('NIL-ID', 'GLAN', 'PAID', 'NCAA ID', 'GLN', 'World Rugby Player ID', 'UCI Code', 'WDSF ID', 'FIDE ID', 'ESIC Player ID', 'Riot Player PUUID', 'SteamID64')
      and target_code_type in ('NIL-ID', 'GLAN', 'PAID', 'NCAA ID', 'GLN', 'World Rugby Player ID', 'UCI Code', 'WDSF ID', 'FIDE ID', 'ESIC Player ID', 'Riot Player PUUID', 'SteamID64')) or
    (chain = 'film' and source_code_type in ('EIDR', 'ISAN', 'Ad-ID', 'CAMA ID')
      and target_code_type in ('EIDR', 'ISAN', 'Ad-ID', 'CAMA ID')) or
    (chain = 'fine_art' and source_code_type in ('DARIA', 'OAI-PMH', 'LIDO', 'GND', 'ULAN', 'AAT', 'CRSA', 'ARK', 'Art Loss Register ID', 'Handle System Prefix', 'SICI', 'Museum ID', 'Accession Number', 'Object ID', 'VRA Core ID', 'CIDOC-CRM ID', 'CDWA ID', 'CITES Certificate ID', 'CONA ID', 'Spectrum Accession ID')
      and target_code_type in ('DARIA', 'OAI-PMH', 'LIDO', 'GND', 'ULAN', 'AAT', 'CRSA', 'ARK', 'Art Loss Register ID', 'Handle System Prefix', 'SICI', 'Museum ID', 'Accession Number', 'Object ID', 'VRA Core ID', 'CIDOC-CRM ID', 'CDWA ID', 'CITES Certificate ID', 'CONA ID', 'Spectrum Accession ID')) or
    (chain = 'spatial' and source_code_type in ('GIAI', 'GRAI', 'H3 Index', 'Geohash', 'EAN Spatial Hardware SKU', 'UPC Spatial Hardware SKU', 'ISO 19115 Metadata Code', 'OpenStreetMap Node', 'OpenStreetMap Way', 'OpenStreetMap Relation', 'UPRN')
      and target_code_type in ('GIAI', 'GRAI', 'H3 Index', 'Geohash', 'EAN Spatial Hardware SKU', 'UPC Spatial Hardware SKU', 'ISO 19115 Metadata Code', 'OpenStreetMap Node', 'OpenStreetMap Way', 'OpenStreetMap Relation', 'UPRN')) or
    (chain = 'fitness_health' and source_code_type in ('NPI', 'CPT', 'FIT-ID', 'IEEE 11073', 'DICOM Study Instance UID', 'HL7/FHIR Resource ID', 'LOINC Code')
      and target_code_type in ('NPI', 'CPT', 'FIT-ID', 'IEEE 11073', 'DICOM Study Instance UID', 'HL7/FHIR Resource ID', 'LOINC Code')) or
    (chain = 'culinary' and source_code_type in ('GTIN', 'GPC', 'PLU', 'GS1-128', 'SSCC', 'FDC ID', 'GSI Recipe Hash', 'GTIN-14/ITF-14', 'GS1 Digital Link URI', 'e-Bacchus ID', 'e-Ambrosia ID')
      and target_code_type in ('GTIN', 'GPC', 'PLU', 'GS1-128', 'SSCC', 'FDC ID', 'GSI Recipe Hash', 'GTIN-14/ITF-14', 'GS1 Digital Link URI', 'e-Bacchus ID', 'e-Ambrosia ID')) or
    (chain = 'wellness' and source_code_type in ('UPRN', 'GIAI-Wellness', 'CosIng')
      and target_code_type in ('UPRN', 'GIAI-Wellness', 'CosIng')) or
    (chain = 'dev_infra' and source_code_type in ('PURL', 'SWID', 'SPDX', 'CVE', 'DOIP')
      and target_code_type in ('PURL', 'SWID', 'SPDX', 'CVE', 'DOIP')) or
    (chain = 'patent' and source_code_type in ('DocDB', 'INPADOC', 'CPC', 'IPC', 'WIPO ST.3', '3GPP Specification ID', 'FCC ID', 'CE Mark Certification Code')
      and target_code_type in ('DocDB', 'INPADOC', 'CPC', 'IPC', 'WIPO ST.3', '3GPP Specification ID', 'FCC ID', 'CE Mark Certification Code')) or
    (chain = 'energy' and source_code_type in ('EIC', 'REC Serial', 'Carbon Credit Serial', 'GS1 GSRN', 'APN Land Sub-Parcel UUID', 'I-REC Code')
      and target_code_type in ('EIC', 'REC Serial', 'Carbon Credit Serial', 'GS1 GSRN', 'APN Land Sub-Parcel UUID', 'I-REC Code')) or
    (chain = 'podcasting' and source_code_type in ('GUID', 'IAB Podcast ID')
      and target_code_type in ('GUID', 'IAB Podcast ID')) or
    (chain = 'gaming' and source_code_type in ('Platform SKU', 'Title ID', 'Asset Store ID', 'glTF Hash', 'USD Hash')
      and target_code_type in ('Platform SKU', 'Title ID', 'Asset Store ID', 'glTF Hash', 'USD Hash')) or
    (chain = 'livestream' and source_code_type in ('Match UUID', 'Tournament UUID', 'Stream Key Hash')
      and target_code_type in ('Match UUID', 'Tournament UUID', 'Stream Key Hash')) or
    (chain = 'fashion' and source_code_type in ('SKU', 'EPC', 'RFID Tag')
      and target_code_type in ('SKU', 'EPC', 'RFID Tag')) or
    (chain = 'ai_data' and source_code_type in ('Dataset Hash', 'CID', 'Voice Model ID')
      and target_code_type in ('Dataset Hash', 'CID', 'Voice Model ID')) or
    (chain = 'theater' and source_code_type in ('AGBOR ID', 'Grand Rights ID')
      and target_code_type in ('AGBOR ID', 'Grand Rights ID')) or
    (chain = 'brand_licensing' and source_code_type in ('Style Guide SKU', 'Licensee Contract ID')
      and target_code_type in ('Style Guide SKU', 'Licensee Contract ID')) or
    (chain = 'web_comics' and source_code_type in ('Webtoon Story ID', 'Platform Story ID', 'Serialization Episode UUID')
      and target_code_type in ('Webtoon Story ID', 'Platform Story ID', 'Serialization Episode UUID')) or
    (chain = 'corporate' and source_code_type in ('DUNS', 'LEI', 'BIC/SWIFT Code', 'EIN', 'VAT ID', 'Tax ID')
      and target_code_type in ('DUNS', 'LEI', 'BIC/SWIFT Code', 'EIN', 'VAT ID', 'Tax ID')) or
    (chain = 'salon_beauty' and source_code_type in ('CAS Registry Number', 'FDA UNII', 'INCI Name/ID')
      and target_code_type in ('CAS Registry Number', 'FDA UNII', 'INCI Name/ID'))
      );
  end if;
end
$$;

-- One mapping per (chain, source, target-type, target-value) — the engine
-- walks deterministically, so duplicates are forbidden.
create unique index if not exists uq_identifier_cross_mappings_source_target
  on public.identifier_cross_mappings
  (chain, source_code_type, source_code_value, target_code_type, target_code_value);
create index if not exists idx_identifier_cross_mappings_source
  on public.identifier_cross_mappings (source_code_type, source_code_value);

comment on table public.identifier_cross_mappings is
  'Cross-code identifier mappings across the twenty-one-chain identifier canon (V1 universal-identifier directive 2026-09-30; canons v2-v10 extend the families: cultural property, esports,
  -- case serialization, layered land rights, telecom SEP certification, fine art, spatial, fitness-health, culinary, wellness, developer-infrastructure, patent, energy, podcasting, gaming, livestream, fashion, AI-data, theater, brand-licensing, web-comics, salon-beauty, and corporate settlement counterparties).';

alter table public.identifier_cross_mappings enable row level security;
grant all on public.identifier_cross_mappings to service_role;

-- ---------------------------------------------------------------------------
-- The pg_net completion webhook — STRICT NO-OP while app.recon_webhook_url
-- is unset (polling is the v1 completion path). Fires on the status UPDATE
-- into a terminal state only. Every failure inside the notify is caught:
-- the webhook can never block or fail the worker's transaction.
-- ---------------------------------------------------------------------------
create or replace function public.notify_recon_job_complete()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_url     text;
  v_secret  text;
  v_headers jsonb;
begin
  if new.status is distinct from old.status
     and new.status in ('completed', 'failed') then
    v_url := current_setting('app.recon_webhook_url', true);
    if v_url is null or v_url = '' then
      return null; -- unconfigured: the strict no-op the spec requires
    end if;
    v_secret := current_setting('app.recon_webhook_secret', true);
    v_headers := jsonb_build_object('Content-Type', 'application/json');
    if v_secret is not null and v_secret <> '' then
      v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_secret);
    end if;
    begin
      perform net.http_post(
        url := v_url,
        headers := v_headers,
        body := jsonb_build_object('job_id', new.id, 'status', new.status, 'error', new.error, 'result', new.result),
        timeout_milliseconds := 5000
      );
    exception when others then
      -- Webhook failure is logged-and-dropped: never blocks, never fails
      -- the worker transaction, never rolls a completed job back.
      return null;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_recon_job_complete on public.royalty_recon_jobs;
create trigger trg_recon_job_complete
  after update of status on public.royalty_recon_jobs
  for each row
  when (new.status in ('completed', 'failed') and new.status is distinct from old.status)
  execute function public.notify_recon_job_complete();

-- ---------------------------------------------------------------------------
-- Authorization: RLS deny-all (no policies) + full service-role grants, the
-- migrations 0001–0010 convention. The store seam and the CVT worker are
-- the only writers.
-- ---------------------------------------------------------------------------

alter table public.royalty_recon_jobs enable row level security;
grant all on public.royalty_recon_jobs to service_role;
grant execute on function public.claim_royalty_recon_job(timestamptz, text) to service_role;

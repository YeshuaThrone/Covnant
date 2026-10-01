-- ---------------------------------------------------------------------------
-- Migration 0017 — podcast episode split ledger + guest milestone bonuses
-- (Deep Royalties PR 11, todo_1NYAzRvp).
--
-- The four tables the podcast episode-split engine owns:
--
--   podcast_episode_split_schedules — the registered per-episode routing.
--     ONE validated schedule per episode (jsonb splits): the founder podcast
--     directive's dynamic per-episode deals (a flagship episode pays host
--     60 / co-host 30 / editor+producer 10 while the next episode pays a
--     different sheet entirely). The TypeScript module
--     (src/modules/podcastSplits/engine.ts) is the registration gate —
--     share_bps must sum to EXACTLY 10000 (100.0000%); rows are what passed
--     it, versioned monotonically per re-registration.
--
--   podcast_episode_split_accruals — the routing-decision record for ONE
--     holding credit. One row per funding queue event (unique on
--     source_event_id): the per-holder integer-cent accrual detail, floor
--     shares with the remainder swept as company dust (allocations plus
--     dust equals gross). A replayed ingest re-derives the same
--     source_event_id and the UNIQUE constraint turns the replay into a
--     counted no-op — the PR #93 per-source guard pattern.
--
--   podcast_guest_bonus_definitions — the contractual guest milestones. One
--     row per (episode, guest, milestone_kind, threshold): downloads counts
--     VERIFIED qualified impressions (`podcast:imp:` rows); reach adds the
--     verified subscription listening (`podcast:sub:` rows). The TypeScript
--     engine is the registration gate — thresholds and bonus amounts are
--     safe integer values, never floats.
--
--   podcast_guest_bonus_accruals — the once-only milestone record. One row
--     per content-derived event id (`podcast:bonus:<episode>:<definition>:
--     <threshold>`): identity is WHAT crossed, never when, so replaying the
--     same episode data derives the same id and the UNIQUE constraint makes
--     the replay a no-op — a threshold crossing accrues exactly once, no
--     clock, no counter drift, no double pay. Lifecycle: inserted status
--     'accrued' BEFORE the bonus posts to unclaimed holding (insert-as-lock,
--     the film routing decision's precedent), flipped 'posted' on posting
--     success, DELETED when the post refuses (retryable).
--
-- ADDITIVE migration at the next-free number (0011-0016 are taken). Nothing
-- existing is dropped or altered. House pattern (0006/0010/0011): check-
-- constrained vocabulary, RLS deny-all, full service_role grant,
-- insertion_order bigint. This file is idempotent — CI applies it twice;
-- every object uses IF NOT EXISTS.
-- ---------------------------------------------------------------------------

create table if not exists public.podcast_episode_split_schedules (
  episode_id    text primary key,
  show_cbt_code text,
  splits        jsonb not null,
  version       bigint not null default 1 check (version >= 1),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.podcast_episode_split_schedules is
  'Podcast episode splits (PR 11): the registered per-episode routing — one validated split schedule per episode, stored jsonb. The TypeScript engine is the registration gate (share_bps must sum to exactly 10000 bps); rows are what passed it.';
comment on column public.podcast_episode_split_schedules.episode_id is
  'The podcast episode the schedule routes for — the ingest payload''s podcast.episode_id. One schedule per episode; a re-registration replaces the row and bumps the version.';
comment on column public.podcast_episode_split_schedules.show_cbt_code is
  'The vault show the episode''s DOI resolves to (matched_cbt_code), when known — provenance, not routing state.';
comment on column public.podcast_episode_split_schedules.splits is
  'The per-holder routing: payee_id, payee_name, role, and share_bps per holder. Sum must be EXACTLY 10000 bps (100.0000%) — validated at registration and re-validated at every accrual.';
comment on column public.podcast_episode_split_schedules.version is
  'Monotonic registration version — bumped on every accepted re-registration. Existing accruals keep the version they were computed against; history is never rewritten.';

create table if not exists public.podcast_episode_split_accruals (
  id                 uuid primary key default gen_random_uuid(),
  episode_id         text not null,
  -- match_queue.event_id is TEXT (0007) — the FK must match the referenced
  -- column's type exactly (the 0011 statement_ingests precedent).
  source_event_id    text not null unique,
  source_amount_cents bigint not null default 0 check (source_amount_cents >= 0),
  split_version      bigint not null check (split_version >= 1),
  accruals           jsonb not null,
  company_dust_cents bigint not null default 0 check (company_dust_cents >= 0),
  created_at         timestamptz not null default now(),
  insertion_order    bigint generated always as identity
);

comment on table public.podcast_episode_split_accruals is
  'Podcast episode splits (PR 11): the routing-decision record for ONE holding credit — the per-holder integer-cent accrual (floor shares, remainder swept as company dust). Allocations plus dust equals gross, always.';
comment on column public.podcast_episode_split_accruals.source_event_id is
  'The funding queue event — match_queue.event_id (`podcast:imp:`/`podcast:sub:`; 0007), the same id the holding credit carries as its line_item_id and journal ref. UNIQUE: one accrual per funding event, ever; a replayed ingest is a counted no-op.';
comment on column public.podcast_episode_split_accruals.source_amount_cents is
  'The creator net that was routed, integer cents (gross minus the network commission the posting pass already deducted).';
comment on column public.podcast_episode_split_accruals.split_version is
  'The schedule version the accrual was computed against — the schedule may have been re-registered since; history keeps its own version.';
comment on column public.podcast_episode_split_accruals.accruals is
  'The per-holder integer-cent accruals: payee_id, payee_name, role, amount_cents each — floor shares with the remainder swept as company dust.';
comment on column public.podcast_episode_split_accruals.company_dust_cents is
  'The integer-cent dust the sweep routed to the platform variance account — sum(accruals) + dust === source_amount_cents.';

create table if not exists public.podcast_guest_bonus_definitions (
  id                 uuid primary key default gen_random_uuid(),
  episode_id         text not null,
  guest_payee_id     text not null,
  guest_payee_name   text not null,
  milestone_kind     text not null
                     check (milestone_kind in ('downloads', 'reach')),
  threshold          bigint not null check (threshold >= 1),
  bonus_amount_cents bigint not null check (bonus_amount_cents >= 1),
  currency           text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (episode_id, guest_payee_id, milestone_kind, threshold)
);

comment on table public.podcast_guest_bonus_definitions is
  'Podcast guest milestone bonuses (PR 11): the contractual micro-payouts — one bonus per (episode, guest, milestone_kind, threshold). The TypeScript engine is the registration gate; rows are what passed it.';
comment on column public.podcast_guest_bonus_definitions.milestone_kind is
  'The verified audience the threshold reads — downloads: VERIFIED qualified impressions (`podcast:imp:` rows); reach: all verified listening including subscription rows (`podcast:imp:` + `podcast:sub:`).';
comment on column public.podcast_guest_bonus_definitions.threshold is
  'The verified count that triggers the bonus — a safe integer >= 1. Thresholds fire on verified totals, never on raw line counts.';
comment on column public.podcast_guest_bonus_definitions.bonus_amount_cents is
  'The bonus paid on crossing, integer cents >= 1 (never a float) — it posts to unclaimed holding in the definition''s currency.';

create table if not exists public.podcast_guest_bonus_accruals (
  id                 uuid primary key default gen_random_uuid(),
  event_id           text not null unique,
  episode_id         text not null,
  bonus_definition_id uuid not null,
  guest_payee_id     text not null,
  milestone_kind     text not null
                     check (milestone_kind in ('downloads', 'reach')),
  threshold          bigint not null check (threshold >= 1),
  verified_count     bigint not null check (verified_count >= 0),
  bonus_amount_cents bigint not null check (bonus_amount_cents >= 0),
  status             text not null default 'accrued'
                     check (status in ('accrued', 'posted')),
  holding_ledger_id  text,
  created_at         timestamptz not null default now(),
  insertion_order    bigint generated always as identity
);

comment on table public.podcast_guest_bonus_accruals is
  'Podcast guest milestone bonuses (PR 11): the once-only milestone record — one row per content-derived event id, so a threshold crossing accrues exactly once no matter how many times the episode data replays.';
comment on column public.podcast_guest_bonus_accruals.event_id is
  'The content-derived id `podcast:bonus:<episode>:<definition>:<threshold>` — identity is WHAT crossed, never when. UNIQUE: the replay arbiter and the GL journal ref (the canonical posting seam''s per-source guard reads the same id).';
comment on column public.podcast_guest_bonus_accruals.verified_count is
  'The episode''s lifetime verified count that crossed the threshold at accrual time.';
comment on column public.podcast_guest_bonus_accruals.status is
  'Milestone lifecycle — accrued (the crossing is locked, money not yet moved) then posted (the holding credit landed in the Don ledger). A deleted accrued row releases the crossing for retry — the film routing decision''s lifecycle.';
comment on column public.podcast_guest_bonus_accruals.holding_ledger_id is
  'The unclaimed-holding ledger credit the accrual posted, once posted — the standing payout gates (operator settlement approval, verified KYC, vertical compliance) apply downstream, exactly like every other held credit.';

-- The episode's accrual history: routing order reads oldest first.
create index if not exists idx_podcast_episode_split_accruals_episode
  on public.podcast_episode_split_accruals (episode_id, created_at);
create index if not exists idx_podcast_guest_bonus_accruals_episode
  on public.podcast_guest_bonus_accruals (episode_id, created_at);

-- ---------------------------------------------------------------------------
-- Foreign keys: the split accrual hangs off its funding queue row (an
-- accrual cannot exist without its funding event — the per-source guard
-- made structural). The bonus accrual's event_id is NOT a queue row (it is
-- content-derived `podcast:bonus:` in the GL journal-ref space), so no FK
-- there. match_queue.event_id is TEXT not null unique (0007) — the FK
-- matches the referenced column's type exactly (the 0011 precedent).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.podcast_episode_split_accruals'::regclass
      and conname = 'fk_podcast_split_accruals_source_event'
  ) then
    alter table public.podcast_episode_split_accruals
      add constraint fk_podcast_split_accruals_source_event
      foreign key (source_event_id) references public.match_queue (event_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Authorization: RLS deny-all (no policies) + full service-role grants, the
-- migrations 0001-0016 convention. The store seam is the only writer; the
-- accrual passes and the payout gates are the only readers.
-- ---------------------------------------------------------------------------

alter table public.podcast_episode_split_schedules enable row level security;
alter table public.podcast_episode_split_accruals enable row level security;
alter table public.podcast_guest_bonus_definitions enable row level security;
alter table public.podcast_guest_bonus_accruals enable row level security;
grant all on public.podcast_episode_split_schedules to service_role;
grant all on public.podcast_episode_split_accruals to service_role;
grant all on public.podcast_guest_bonus_definitions to service_role;
grant all on public.podcast_guest_bonus_accruals to service_role;

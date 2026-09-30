-- ============================================================================
-- Covnant — Deep Royalties recon job queue (0011)
-- The durable orchestration table for the royalty-recon engine (spec
-- art_7M0snhxc): the UCT layer's sync routes enqueue one row and return
-- 202 — the request cycle never parses, never calls a model, never fans
-- out — and the CVT worker (a standalone process outside Vercel) claims,
-- parses, and completes jobs in the background lane.
--
-- Two deliberate reuses, both locked decisions from the spec:
--   - The parsed line items are NOT stored here. match_queue (0007) IS the
--     line-item store — the directive's "royalty_recon_line_items" already
--     exists under that name. This table is orchestration only.
--   - The claim concurrency is the settlement canon (0009): one atomic
--     claim_royalty_recon_job() RPC with FOR UPDATE SKIP LOCKED (two
--     workers can never hold one job), a 30-minute stale-claim recovery
--     (a crashed worker's job re-enters the pool), and the attempts cap 3
--     (the worker's failReconJob makes failure terminal past the budget —
--     no sweeper process exists; crash recovery IS the claim query).
--
-- Conventions, per migrations 0006–0010:
--  - Text UUIDs (gen_random_uuid default), timestamptz walls written as
--    ISO strings by the store. The store still mints ids app-side
--    (randomUUID); the database default covers any non-store writer.
--  - bigint generated always as identity = insertion_order (rowid
--    substitute; the claim's created_at tiebreak on the local stores'
--    rowid/array-index equivalents).
--  - Every statement is idempotent (if not exists / or replace / drop +
--    create): re-running the file is a no-op.
--  - RLS is enabled with no policies (deny-all); only the service role —
--    the store seam and the CVT worker — reads and writes.
--
-- Completion webhook: notify_recon_job_complete() POSTs the job's id and
-- status to the UCT callback route (/api/covnant/recon/jobs/callback) via
-- pg_net when the database settings app.recon_webhook_url and
-- app.recon_webhook_secret are set — e.g.
--   alter database <db> set app.recon_webhook_url = 'https://.../callback';
-- While they are unset the trigger is a strict NO-OP: polling
-- (GET /api/covnant/recon/jobs/:id) is the v1 completion path, and the
-- webhook activates by configuration only when the worker host lands.
-- The EXCEPTION wrapper is load-bearing: a webhook failure (pg_net absent,
-- host down, bad URL) is logged-and-dropped, never allowed to fail the
-- worker's transaction or roll a completed job back.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The orchestration queue — one row per requested recon run.
-- ---------------------------------------------------------------------------
create table if not exists public.royalty_recon_jobs (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'pending'
                check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  source        text not null,
  ingest_id     text references public.statement_ingests (id),
  requested_by  uuid,
  engine        text,
  attempts      int not null default 0,
  error         text,
  result        jsonb,
  claimed_at    timestamptz,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
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
-- The claim RPC — the settlement concurrency canon (0009): one atomic
-- statement, FOR UPDATE SKIP LOCKED so concurrent workers serialize on the
-- pool, stale-claim recovery built into the candidate filter, attempts
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
  v_url    text;
  v_secret text;
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

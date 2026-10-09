-- =============================================================================
-- 0064 — HOTFIX: claim_royalty_recon_job re-ran poison jobs forever (C5)
--
-- The Deep Royalties recon claim RPC (migration 0011) re-claimed a stale
-- 'processing' row with NO attempts predicate: a worker that crashed
-- mid-execution never reports failure, so its job stayed stale 'processing'
-- and every stale-claim recovery re-entered the pool — claim, re-run with
-- FULL side effects, crash, wait 30 minutes, claim again, forever. The
-- retry budget existed only on the REPORTED-failure path (failReconJob
-- terminal-fails at attempts >= RECON_MAX_ATTEMPTS); a poison job never
-- reports, so the budget never reached it.
--
-- Fix: the claim-time cap. A candidate whose attempts have already reached
-- the budget (store.ts's RECON_MAX_ATTEMPTS = 3 — the two move together)
-- is terminal-failed by the claim itself — status 'failed' with an honest
-- error and completed_at — and the RPC returns NULL: the caller's contract
-- is "NULL = nothing claimed", so the CVT worker sleeps one poll interval
-- and the next claim proceeds past the now-terminal row. Stale-claim
-- recovery is otherwise unchanged (a stale claim under the budget is
-- re-claimed and incremented exactly as before), and rows under the budget
-- claim normally. The enforcement now lives in every claim path — this
-- RPC for the Supabase backend and the store seam for the in-memory and
-- SQLite backends (store.ts RECON_ATTEMPTS_CAP_ERROR carries the error
-- text verbatim) — so the queue cannot fork per backend.
--
-- Amendment convention (the 0057 -> 0061 precedent): this is a NEW
-- migration — the shipped 0011 file is never edited in place. The body is
-- create or replace with an IDENTICAL signature ((timestamptz, text) ->
-- jsonb), so PostgREST callers see no shape change; only the language
-- moves sql -> plpgsql (the 0061 precedent) to branch between the
-- claim and the terminal-fail while holding the row lock the candidate
-- select took (FOR UPDATE SKIP LOCKED serializes concurrent workers
-- exactly as the single-statement UPDATE did).
--
-- Regression coverage: the three-backend parity suite plus the worker
-- E2E test (reconQueueParity.test.ts / workers/recon worker.test.ts) for
-- the store seam and the behavioral RPC fake, and the CI schema job's
-- "Recon claim attempts-cap regression" step, which CALLS this RPC on
-- real scratch Postgres against a seeded poison row — the call-level
-- blind spot that let 0057 ship (see 0061's header).
--
-- Idempotency (CI applies every migration twice): create or replace
-- function re-runs as a no-op, and grant execute is additive.
-- =============================================================================

-- The claim: pick the oldest claimable row (pending, or stale processing),
-- hold its lock, then either terminal-fail a budget-exhausted candidate or
-- transition to 'processing' with the attempts increment. Returns the
-- post-claim row as jsonb, or NULL when nothing was claimed.
create or replace function public.claim_royalty_recon_job(
  p_now    timestamptz default now(),
  p_engine text        default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  candidate public.royalty_recon_jobs%rowtype;
  claimed   public.royalty_recon_jobs%rowtype;
begin
  select * into candidate
  from public.royalty_recon_jobs
  where status = 'pending'
     or (status = 'processing' and claimed_at < p_now - interval '30 minutes')
  order by created_at
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  -- The claim-time cap (C5): a candidate past the budget is a poison job —
  -- its worker crashed without reporting, and re-running it would repeat
  -- the full side-effect pass. Terminal-fail honestly instead; attempts
  -- stays at the cap (no claim increment) so the row shows the executions
  -- that actually happened.
  if candidate.attempts >= 3 then
    update public.royalty_recon_jobs
    set status = 'failed',
        error = 'retry_budget_exhausted: stale claim past the attempts cap, terminal-failed at claim time',
        completed_at = p_now,
        updated_at = p_now
    where id = candidate.id;
    return null;
  end if;

  update public.royalty_recon_jobs
  set status = 'processing',
      engine = p_engine,
      claimed_at = p_now,
      started_at = coalesce(started_at, p_now),
      attempts = attempts + 1,
      updated_at = p_now
  where id = candidate.id
  returning * into claimed;

  if not found then
    return null;
  end if;
  return to_jsonb(claimed);
end;
$$;

grant execute on function public.claim_royalty_recon_job(
  timestamptz, text
) to service_role;

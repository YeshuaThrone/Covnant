-- ============================================================================
-- Covnant — Admin action log (migration 0005)
-- The append-only audit trail for admin console mutations (Generation 13).
-- One row per mutation: the operator (actor), what was done (action), the
-- record it touched (target_table + target_row_id), and the field-level
-- before/after (changes jsonb — { field: { from, to } }).
--
-- Append-only by construction: the app layer exposes INSERT only (see
-- src/lib/admin/actionLog.ts) and no role is granted UPDATE or DELETE —
-- the table carries NO anon/authenticated policies, so RLS denies every
-- non-service-role access (the deny-all default; the service role bypasses
-- RLS, matching migrations 0001/0003). Rows are never updated, never
-- deleted.
--
-- target_row_id is nullable by design: today's mutations target
-- creator_profiles and platform_allowlists (both uuid-keyed), but the log's
-- contract is wider than any one target table's key shape.
-- ============================================================================

create table if not exists public.admin_action_log (
  id            uuid primary key default gen_random_uuid(),
  actor         text not null default 'admin',
  action        text not null,
  target_table  text not null,
  target_row_id uuid,
  changes       jsonb not null,
  created_at    timestamptz not null default now()
);

-- Domain documentation in the house style — the comment IS the contract.
comment on table public.admin_action_log is
  'Append-only audit trail for admin console mutations: exactly one row per mutation, field-level before/after in changes ({ field: { from, to } }). Never updated, never deleted.';

comment on column public.admin_action_log.actor is
  'Operator identity. The shared-secret gate carries no per-human identity until session auth layers on — the constant ''admin'' until then.';

comment on column public.admin_action_log.action is
  'Machine action code — creator.compliance.update, allowlist.status_flip.';

comment on column public.admin_action_log.changes is
  'Field-level before/after — { field: { from, to } }. Only the fields the mutation actually changed; never a whole-object snapshot.';

alter table public.admin_action_log enable row level security;

-- No policies: anon and authenticated get nothing (deny-all default).
grant all on public.admin_action_log to service_role;

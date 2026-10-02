-- =============================================================================
-- 0028 — AI model registry: nested derivative split terms + contributor
--        dataset token weights (PR 24)
--
-- The AI lane's terms of record, per the founder AI directive + the
-- tokenization patch:
--
--   ai_model_split_terms     <- upsertAiModelSplitTerms / getAiModelSplitTerms
--     (one model's nested derivative split contract — UNIQUE per
--      ai_model_id, an upsert converges: the newest contract governs the
--      next ingest, never a duplicate. The directive's defaults
--      (2000/5000/3000 bps) are rows' values, not code: configurable per
--      contract. The nested ORDER is schema-enforced — the fine-tuner
--      split and the contributor pool both price the POST-FEE remainder,
--      so together they can never exceed it.)
--   ai_model_contributions   <- upsertAiModelContribution /
--                               listAiModelContributions
--     (one contributor's registered dataset token weight on one model —
--      UNIQUE (ai_model_id, contributor_payee_id): a re-shipped
--      attribution log is an upsert, never a double registration. The
--      registry is the posting pass's model registry: an unattributed
--      inference event's contributor pool resolves through exactly these
--      rows, and training-pool royalties distribute pro-rata by the
--      registered token weights.)
--
-- The weights and the money discipline: dataset_token_weight is EXACT
-- decimal TEXT (the 1e-8 micros space — the devex log's virtual_amount /
-- exchange_rate precedent; a float column cannot hold the exact bigint
-- math the lane runs). The bps columns are whole basis points inside
-- 0–10000, CHECK-enforced at rest here and lane-enforced at write.
--
-- No money table is new here: the nested split posts through the recon
-- posting pass as per-leg quarantined credits in the existing
-- ledger_transactions machinery (the 0006 holding-state precedent every
-- lane shares) — this migration carries only the registry facts.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with a full service-role grant (the 0017–0027
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ai_model_split_terms: the nested derivative split contract of record per
-- model. base_model_provider_fee_bps prices the provider's system fee off
-- the top of a usage event's total API token revenue; developer_split_bps
-- and contributor_pool_bps price the fine-tuner/LoRA creator's split and
-- the data+voice+original-IP contributor pool off the POST-FEE remainder
-- (the model operator's margin is the exact complement — computed, never
-- stored). The nested-order constraint developer + pool <= 10000 makes a
-- contract that over-commits the remainder unrepresentable at rest.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_model_split_terms (
  id                              uuid primary key default gen_random_uuid(),
  ai_model_id                     text not null,
  base_model_provider_fee_bps     integer not null,
  developer_split_bps             integer not null,
  contributor_pool_bps            integer not null,
  base_model_provider_payee_id    text not null,
  base_model_provider_payee_name  text not null,
  developer_payee_id              text not null,
  developer_payee_name            text not null,
  model_operator_payee_id         text not null,
  model_operator_payee_name       text not null,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  unique (ai_model_id),
  constraint ai_model_split_terms_fee_check
    check (base_model_provider_fee_bps >= 0 and base_model_provider_fee_bps <= 10000),
  constraint ai_model_split_terms_developer_check
    check (developer_split_bps >= 0 and developer_split_bps <= 10000),
  constraint ai_model_split_terms_pool_check
    check (contributor_pool_bps >= 0 and contributor_pool_bps <= 10000),
  constraint ai_model_split_terms_nested_order_check
    check (developer_split_bps + contributor_pool_bps <= 10000)
);

comment on table public.ai_model_split_terms is
  'One model''s nested derivative split contract of record: the base foundation model provider''s system fee (bps off the top), the fine-tuner/LoRA creator''s split and the data+voice+original-IP contributor pool (bps of the post-fee remainder), and the three payees of record. UNIQUE per model; an upsert converges — the newest contract governs the next ingest. The directive''s defaults (2000/5000/3000 bps) are row values, configurable per contract.';

-- ---------------------------------------------------------------------------
-- ai_model_contributions: the training registry — one contributor's
-- registered dataset token weight on one model. The class
-- (dataset | voice | original_ip) is the attribution fact of record (the
-- audit trail), never a money-math input: the pro-rata weights price the
-- shares. The weight is exact decimal text in the 1e-8 micros space.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_model_contributions (
  id                     uuid primary key default gen_random_uuid(),
  ai_model_id            text not null,
  contributor_payee_id   text not null,
  contributor_payee_name text not null,
  contributor_class      text not null,
  dataset_token_weight   text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (ai_model_id, contributor_payee_id),
  constraint ai_model_contributions_class_check
    check (contributor_class in ('dataset', 'voice', 'original_ip')),
  constraint ai_model_contributions_weight_check
    check (dataset_token_weight::numeric > 0)
);

create index if not exists ai_model_contributions_model_idx
  on public.ai_model_contributions (ai_model_id);

comment on table public.ai_model_contributions is
  'The training registry: one contributor''s registered dataset token weight on one model, with the contributor class of record (dataset, voice, or original_ip). UNIQUE (ai_model_id, contributor_payee_id) — a re-shipped attribution log is an upsert, never a double registration. The weight is exact decimal text; the posting pass resolves an unattributed event''s contributor pool through these rows and distributes training-pool royalties pro-rata by them.';

-- ---------------------------------------------------------------------------
-- Row-level security: deny-all with an explicit policy, so the
-- "denied by RLS" audit surface stays; the explicit grant keeps the
-- service-role write path.
-- ---------------------------------------------------------------------------

alter table public.ai_model_split_terms enable row level security;
alter table public.ai_model_contributions enable row level security;

drop policy if exists ai_model_split_terms_service_role_all
  on public.ai_model_split_terms;
create policy ai_model_split_terms_service_role_all
  on public.ai_model_split_terms
  for all
  using (false)
  with check (false);

drop policy if exists ai_model_contributions_service_role_all
  on public.ai_model_contributions;
create policy ai_model_contributions_service_role_all
  on public.ai_model_contributions
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.ai_model_split_terms to service_role;
grant select, insert, update, delete on public.ai_model_contributions to service_role;

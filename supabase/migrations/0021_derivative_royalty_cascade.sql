-- ---------------------------------------------------------------------------
-- Migration 0021 — Derivative asset royalty cascade: per-edge fractional
-- royalty contracts (Deep Royalties PR 16, todo_JNTOlQb9).
--
-- When a derivative micro-item or mod sells, the cascade allocator walks the
-- parent_asset_id dependency tree (the column the recon queue has carried
-- since migration 0011) depth-first and distributes fractional royalties to
-- the upstream 3D mesh, texture, and code script creators BEFORE allocating
-- net profits to the downstream modder.
--
--   derivative_royalty_edges — the per-edge contracts. One row per
--     (asset_id, parent_asset_id, upstream_creator_payee_id): the edge a
--     derivative builds on pays its contracted fraction of a downstream
--     sale. The allocator's depth-first walk reads this table per node
--     (getDerivativeRoyaltyEdgesByAsset); the reservation order is the
--     table's insertion order — the deterministic upstream-first sequence.
--     A self-edge (asset_id = parent_asset_id) is refused at the DDL —
--     the allocator's path-based cycle detection catches every longer
--     malformed tree (D→P→D, D→P→Q→D) fail-closed at plan time.
--
-- The PAYOUT state needs no table: every cent moves through the canonical
-- recon posting seam into UNCLAIMED_HOLDING (the PR 2/PR 7 seam) and
-- releases through releaseUnclaimedHolding's clearance-gated path — the
-- ledger rows, GL journals, withholding escrow, recoupment sweeps, and the
-- dust-to-platform variance sweep are the existing ledger contract. Replay
-- idempotency rides the seam's journal-ref guard on the sale event's
-- content-derived unique event id (the `derivative:resale:` identity space
-- for secondary-marketplace resales — the podcast:bonus: precedent).
--
-- ADDITIVE migration at the next-free number (0011-0020 are taken; 0020 is
-- the VTuber agency holdback state, merged to main). Nothing existing is
-- dropped or altered. House pattern (0006/0010/0011/0017/0019/0020):
-- check-constrained vocabulary, RLS deny-all, full service_role grant,
-- insertion_order bigint. This file is idempotent — CI applies it twice;
-- every object uses IF NOT EXISTS.
-- ---------------------------------------------------------------------------

create table if not exists public.derivative_royalty_edges (
  id             uuid primary key default gen_random_uuid(),
  -- The derivative (child) asset the contract hangs off — the sold item's
  -- walk STARTS here and follows parent_asset_id upstream.
  asset_id       text not null,
  -- The upstream asset this derivative builds on (3D mesh, texture pack,
  -- code script, ...). NOT a match_queue row — the asset registry is the
  -- vault's, so no FK (the 0017/0019/0020 precedent for registry keys).
  parent_asset_id text not null,
  -- The upstream creator the edge pays (the mesh/texture/script rights
  -- holder) — the Don store's sovereign identity.
  upstream_creator_payee_id text not null,
  -- The payee's display name of record at registration (the podcast bonus
  -- definition's guest_payee_name precedent — contract rows carry the
  -- payee's name so the payout path needs no second hop).
  upstream_creator_payee_name text not null,
  -- The edge's fraction of a downstream sale gross, basis points (0 < bps
  -- <= 10000). Integer cents are floor(bps * gross / 10000) — the house
  -- allocator's exact math; the walk refuses a tree whose contracted bps
  -- exceed 10000 (fail-closed, naming the breaching edge).
  royalty_bps    integer not null
                 check (royalty_bps > 0 and royalty_bps <= 10000),
  created_at     timestamptz not null default now(),
  -- Deterministic reservation order for the depth-first walk (created_at
  -- is not unique; the identity column is the strict tiebreak).
  insertion_order bigint generated always as identity,
  -- One contract per (edge, payee): a re-registration of the same triple
  -- throws (23505 / UNIQUE — the replay surface). Distinct payees may hold
  -- distinct fractions on ONE edge (co-holders); the allocator reserves
  -- each as its own contract row.
  unique (asset_id, parent_asset_id, upstream_creator_payee_id),
  -- A self-edge is a malformed tree at the DDL, before the allocator ever
  -- sees it.
  check (asset_id <> parent_asset_id)
);

comment on table public.derivative_royalty_edges is
  'Derivative asset royalty cascade (PR 16): per-edge fractional royalty contracts over the parent_asset_id dependency tree — one row per (asset_id, parent_asset_id, upstream_creator_payee_id). The allocator''s depth-first walk pays each edge''s creator floor(royalty_bps * sale_gross / 10000) integer cents BEFORE the downstream modder''s net; contracted bps above 10000 across a tree refuse fail-closed.';
comment on column public.derivative_royalty_edges.asset_id is
  'The derivative (child) asset the contract hangs off — the walk''s start node when this asset sells.';
comment on column public.derivative_royalty_edges.parent_asset_id is
  'The upstream asset this derivative builds on (mesh, texture, script, ...). The walk follows these edges upstream; a cycle among them refuses the plan.';
comment on column public.derivative_royalty_edges.upstream_creator_payee_id is
  'The upstream creator the edge pays — the Don store''s sovereign payee identity.';
comment on column public.derivative_royalty_edges.upstream_creator_payee_name is
  'The payee''s display name of record at registration — contract rows carry it so the payout path needs no second hop.';
comment on column public.derivative_royalty_edges.royalty_bps is
  'The edge''s fraction of a downstream sale gross in basis points (0 < bps <= 10000) — integer cents are floor(bps * gross / 10000), the house allocator''s exact math.';

create index if not exists idx_derivative_royalty_edges_asset
  on public.derivative_royalty_edges (asset_id, insertion_order);
create index if not exists idx_derivative_royalty_edges_parent
  on public.derivative_royalty_edges (parent_asset_id);

-- ---------------------------------------------------------------------------
-- Authorization: RLS deny-all (no policies) + full service-role grants, the
-- migrations 0001-0020 convention. The store seam is the only writer; the
-- cascade allocator's depth-first walk is the only reader.
-- ---------------------------------------------------------------------------

alter table public.derivative_royalty_edges enable row level security;
grant all on public.derivative_royalty_edges to service_role;

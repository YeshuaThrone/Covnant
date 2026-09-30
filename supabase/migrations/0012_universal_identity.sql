-- Universal identity map and global cross-reference — FOUNDER DDL
-- (addendum 29, identifier canon v10, 2026-09-30), carried with the founder
-- names exactly: table names, column names, and constraint names verbatim.
-- universal_identity_map is the entity-level master code registry;
-- global_identifier_cross_ref carries the linked codes plus the evidence
-- fields (verification_source, verified_at) the PR 53 hold-release engine
-- reads for UNCLAIMED_IDENTIFIER_HOLD release. House hardening (RLS,
-- service_role grant) is appended per the migration conventions.

create table if not exists public.universal_identity_map (
  map_id uuid primary key default gen_random_uuid(),
  entity_id uuid not null,
  vertical_category varchar(64) not null,
  primary_code_type varchar(32) not null,
  primary_code_value varchar(128) not null,
  created_at timestamptz default now(),
  constraint unique_code_per_type unique (primary_code_type, primary_code_value)
);

create index if not exists idx_universal_primary_code
  on public.universal_identity_map (primary_code_type, primary_code_value);

create table if not exists public.global_identifier_cross_ref (
  ref_id uuid primary key default gen_random_uuid(),
  map_id uuid references public.universal_identity_map (map_id) on delete cascade,
  linked_code_type varchar(32) not null,
  linked_code_value varchar(128) not null,
  verification_source varchar(64) not null,
  verified_at timestamptz default now(),
  constraint unique_cross_reference unique (map_id, linked_code_type, linked_code_value)
);

create index if not exists idx_cross_ref_linked_code
  on public.global_identifier_cross_ref (linked_code_type, linked_code_value);

comment on table public.universal_identity_map is
  'Entity-level master identity registry: one primary code per code type per master internal entity, across verticals (founder DDL, canon v10, 2026-09-30). vertical_category carries the compact vertical vocabulary (e.g. FINE_ART, PRO_SPORTS, HARDWARE).';
comment on table public.global_identifier_cross_ref is
  'Linked cross-code references per universal_identity_map row: verification_source names the API registry verifying the link and verified_at stamps it — the evidence fields the PR 53 hold-release engine reads for UNCLAIMED_IDENTIFIER_HOLD release (founder DDL, canon v10, 2026-09-30).';

alter table public.universal_identity_map enable row level security;
alter table public.global_identifier_cross_ref enable row level security;
grant all on public.universal_identity_map to service_role;
grant all on public.global_identifier_cross_ref to service_role;

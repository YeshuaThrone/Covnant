-- ============================================================================
-- Covnant — Creator compliance columns (migration 0004)
-- User compliance schema: KYC status, tax-form classification, tax
-- verification, and bank-account linkage.
--
-- Home table: public.creator_profiles. There is no public users table, and
-- auth.users is Supabase-managed — it is never altered and never referenced
-- in DDL. creator_profiles is the profile home, keyed to auth.users(id) via
-- its id FK, per migration 0003's header design.
--
-- Column mapping: the requested udr_accepted_at already exists on this table
-- as udr_terms_accepted_at (timestamptz not null default now(), migration
-- 0003, written by the signup route) — it is NOT re-added; the requested
-- name maps 1:1 onto that existing column.
--
-- Idempotency: every column is `add column if not exists`, so re-running is
-- a no-op. ADD COLUMN with a constant DEFAULT backfills all existing rows
-- with the default (PostgreSQL 11+ fast-path — no table rewrite).
--
-- Columns, exactly as specified by the user (2026-09-09):
--   kyc_status          VARCHAR(50) DEFAULT 'PENDING_INITIALIZATION'
--                       (values PENDING, VERIFIED, REJECTED)
--   tax_form_type       VARCHAR(20) DEFAULT 'W9'
--                       (values W9, W8BEN, EIN)
--   tax_verified        BOOLEAN     DEFAULT FALSE
--   bank_account_linked BOOLEAN     DEFAULT FALSE
-- (Type names are written lowercase in the DDL below — PostgreSQL type
-- names are case-insensitive; lengths and defaults are exact. Columns are
-- nullable per the user's spec: the default applies on insert-omission.)
-- ============================================================================

alter table public.creator_profiles
  add column if not exists kyc_status varchar(50) default 'PENDING_INITIALIZATION';

alter table public.creator_profiles
  add column if not exists tax_form_type varchar(20) default 'W9';

alter table public.creator_profiles
  add column if not exists tax_verified boolean default false;

alter table public.creator_profiles
  add column if not exists bank_account_linked boolean default false;

-- Persist the user's value domains as database comments. The defaults are
-- the pre-verification starting states (PENDING_INITIALIZATION / W9).
comment on column public.creator_profiles.kyc_status is
  'KYC verification status — values PENDING, VERIFIED, REJECTED. Starts at PENDING_INITIALIZATION.';

comment on column public.creator_profiles.tax_form_type is
  'Tax form classification — values W9, W8BEN, EIN. Defaults to W9.';

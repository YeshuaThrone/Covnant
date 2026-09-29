-- ============================================================================
-- Covnant — in-house phone verification (0010)
-- The phone_verifications table for the signup OTP step (spec art_pd8VlEMI):
-- one row per generated 6-digit code, keyed to the auth user. The code
-- itself is NEVER stored — otp_hash is an HMAC-SHA256 digest over
-- user:phone:code keyed by the server's OTP_HASH_SECRET, so a database read
-- discloses nothing verifiable.
--
-- Lifecycle (all enforced by the routes, server-side):
--   - created by POST /api/covnant/auth/phone/otp with expires_at =
--     created + 5 minutes (OTP_TTL_MINUTES, src/lib/covnant/otp/service.ts).
--   - a resend first marks every prior unexpired unconsumed row for the user
--     consumed (verified_at set) — exactly one live code at a time.
--   - POST /api/covnant/auth/phone/verify consumes the row on a match
--     (verified_at set — single use) and flips
--     creator_profiles.phone_verified_at; a miss increments attempts.
--   - a row is dead once attempts reaches 5 or expires_at passes; dead rows
--     never verify and never hand back a code.
--
-- Conventions, per migrations 0003–0009:
--  - Text UUIDs (gen_random_uuid default), timestamptz walls.
--  - RLS is enabled with NO policies (deny-all): only the service role —
--    the OTP routes' raw-SQL db client — reads and writes this table.
--    Phone verification is deliberately NOT Supabase Auth OTP
--    (src/app/auth/callback/route.ts keeps rejecting SMS token types).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- One row per generated code — hashed at rest, single-use, expiring.
-- ---------------------------------------------------------------------------
create table if not exists public.phone_verifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  phone       text not null,
  otp_hash    text not null,
  expires_at  timestamptz not null,
  verified_at timestamptz,
  attempts    int not null default 0,
  created_at  timestamptz not null default now()
);

-- The routes' hot path: latest row for a user (cooldown check, verify pick).
create index if not exists phone_verifications_user_recent
  on public.phone_verifications (user_id, created_at desc);

alter table public.phone_verifications enable row level security;

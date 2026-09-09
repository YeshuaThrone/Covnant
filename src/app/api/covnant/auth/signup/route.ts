/**
 * POST /api/covnant/auth/signup — CovnantRoyaltyTrackingAPI instant sign-up.
 *
 * Purpose: create the creator's Supabase Auth account + creator_profiles row
 * (the full-payload auth core in src/lib/covnant/covnantSignup.ts), register
 * the self-serve rights holder in the cbt_assets registry, mint the UCT, and
 * trigger the SAME Increase virtual-account provisioning flow the provision
 * route runs — through the shared core in src/lib/covnant/provisioning.ts
 * (no internal HTTP self-calls).
 *
 * Identity model (stated choice, see PR body): cbt_assets rows are creative
 * works in this platform — the SDK registers works and their collaborating
 * rights holders, and every holder lookup (provision, banking, Increase
 * webhook) resolves through cbt_assets.rights_holders JSONB across all
 * rows. A signup has no work yet, so the platform model does NOT imply one
 * cbt_assets row per creator (that would fabricate a pseudo-work per
 * signup). Instead, self-serve identity lives in ONE designated registry
 * row — cbt_code 'CBT-SIGNUP-REGISTRY', title 'Covnant Instant Sign-Up',
 * medium 'SIGNUP_REGISTRY' (a sentinel the catalog renders verbatim) —
 * created lazily on first signup. Its rights_holders array accumulates the
 * self-serve holder entries; per-creator provisioning still serializes on
 * the same row-lock discipline as the provision route.
 *
 * Holder entry shape: the EXACT shape the PR #26 provisioning lookups and
 * tests pin — { rightsHolderId, name, role, payoutRouting } — plus the
 * normalized email as the identity field:
 *   { rightsHolderId: <uuid>, name: <email>, role: 'COMPOSER',
 *     email: <normalized email>, payoutRouting: {} }
 * name starts as the email and payoutRouting starts empty — the creator has
 * no external bank or virtual account yet. Provisioning fills
 * payoutRouting.covenantVirtualAccount exactly per the existing contract.
 *
 * Fail-closed verification (product requirement): when INCREASE_API_KEY or
 * INCREASE_SOURCE_ACCOUNT_ID is unconfigured, signup STILL succeeds —
 * 201 first registration / 200 claim — with provisioning status 'PENDING'
 * plus a machine-readable reason ('INCREASE_NOT_CONFIGURED';
 * 'INCREASE_UNAVAILABLE' when Increase itself fails transiently). NEVER a
 * 500 for those. Unconfigured DATABASE_URL or Supabase credentials stay
 * fail-closed 503.
 *
 * CRITICAL SAFETY: signup responses carry STATUS FIELDS ONLY — never
 * accountNumber, routingNumber, or accountNumberId, provisioned or not.
 * A PENDING response must never carry placeholder numbers a creator could
 * point real payouts at; real numbers surface only through the
 * authenticated product surfaces (the provision route contract).
 *
 * ORDERING INVARIANT (the merge's sharp edge): the registry is checked by
 * normalized email BEFORE signUp. Three outcomes:
 *   - Fresh email → the full 201 flow: signUp → profile insert → registry
 *     find-or-create (the UCT is minted inside the advisory-lock
 *     transaction) → provisioning → 201 union envelope (the live payload
 *     fields PLUS session/user/profile).
 *   - Registry hit with NO auth account (a pre-auth legacy holder who
 *     already holds a UCT) → first-time CLAIM: signUp creates the account
 *     + profile, NO second UCT is minted, and the registry is NOT
 *     rewritten; the response is the status-only 200 — identical shape to
 *     a repeat, because a 200 never discloses a UCT or credential material.
 *   - Registry hit where an auth account already exists → signUp reports
 *     the duplicate → 409 duplicate_email.
 *
 * COMPENSATION INVARIANT: any failure after the auth signup commits deletes
 * the creator_profiles row and the auth user (best-effort, logged —
 * compensateCovnantSignup) before the error is surfaced. The registry/UCT
 * stage registers nothing on failure (the transaction rolls back; the
 * fail-closed 503 UCT_MINT_FAILED semantics are unchanged), so every
 * failure mode is clean-retryable.
 *
 * Scope guards: this route never reads or writes universal_royalty_ledger
 * (zero money movement) and adds no required env vars (it reads the
 * documented Supabase credentials and Increase keys). The former "no
 * Supabase auth-user machinery" guard is retired — this endpoint OWNS auth
 * now (its referenced owner /api/users/register no longer exists). Rate
 * limiting is the drop's per-IP in-memory limiter AFTER validation
 * (src/lib/server/rateLimit.ts — per-isolate memory: bypassable and
 * cold-start-reset on serverless; production hardening needs an external
 * store).
 *
 * UCT (Universal Covnant Tag — the creator-root identity; the canonical
 * Generation 8 expansion of "the universal root identity that follows the
 * creator everywhere; the ultimate fallback that tracks and claims the
 * creator's assets globally"): a CREATING signup also mints
 * UCT-[JURISDICTION]-[YEAR]-[SERIAL]-[CHECKSUM] inside the SAME
 * advisory-lock transaction — issuance is race-safe by construction and
 * independent of Increase configuration. The request gains `engine`
 * (validated whenever present; any non-member value is a sanitized 400)
 * and optional `jurisdiction` (2-char ISO 3166, default "US"); a claim
 * validates both the same way but neither re-mints nor rewrites the
 * holder's immutable issuance facts. The pre-merge { email }-only shape is
 * RETIRED — the full creator payload is required now, and the signup
 * contract doc carries the reconciled union contract. Issuance facts
 * persist immutably on the holder entry (uct, uctCreatedAt,
 * uctJurisdiction, engine). DISCLOSURE: the UCT is returned ONLY on the
 * creating 201 response; a 200 (claim or repeat) carries NO uct key
 * (enumeration protection — an email is never an oracle for someone
 * else's UCT). The serial is crypto-random and uniqueness-checked with
 * bounded retry; failure is fail-closed 503 UCT_MINT_FAILED. The checksum
 * is integrity-only — not a secret, not an auth factor.
 */

import { randomUUID } from 'node:crypto';
import { getDb, type Db } from '@/lib/db';
import {
  provisionRightsHolderVirtualAccount,
  storedVirtualAccount,
} from '@/lib/covnant/provisioning';
import {
  DEFAULT_UCT_JURISDICTION,
  buildUct,
  normalizeEngine,
  normalizeJurisdiction,
  uctIssuanceYear,
  uctSerial,
  type SignupEngine,
} from '@/lib/covnant/uct';
import { validateCovnantSignupPayload } from '@/lib/covnant/signupValidation';
import {
  compensateCovnantSignup,
  registerCovnantCreator,
} from '@/lib/covnant/covnantSignup';
import { jsonError } from '@/lib/server/http';
import { checkRateLimit, REGISTER_RATE_LIMIT } from '@/lib/server/rateLimit';
import {
  createAdminClient,
  createAuthClient,
  readSupabaseEnv,
} from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

/** Designated registry row anchoring self-serve identity (see header). */
const SIGNUP_REGISTRY_CBT_CODE = 'CBT-SIGNUP-REGISTRY';
const SIGNUP_REGISTRY_TITLE = 'Covnant Instant Sign-Up';
const SIGNUP_REGISTRY_MEDIUM = 'SIGNUP_REGISTRY';
/** Advisory-lock key serializing registry find-or-create across signups. */
const SIGNUP_REGISTRY_LOCK = 'covnant-signup-registry';

/** Bounded serial-uniqueness retries before the mint fails closed. */
const UCT_MINT_ATTEMPTS = 3;

/** Connection-scoped query surface handed to a db.transaction callback. */
type TxClient = Parameters<Parameters<Db['transaction']>[0]>[0];

interface RegistryRow {
  id: string;
  rights_holders: unknown;
}

/** The minted creator-root identity, disclosed ONLY on the 201 response. */
interface MintedUct {
  uct: string;
  uctCreatedAt: string;
  jurisdiction: string;
  engine?: SignupEngine;
}

interface SignupRegistration {
  alreadyRegistered: boolean;
  assetId: string;
  rightsHolderId: string;
  holderEntry: unknown;
  /** Null on the idempotent path — a non-creating response carries no UCT. */
  minted: MintedUct | null;
}

/** Outcome of the preserved Increase provisioning block. */
type ProvisioningOutcome =
  | { fault: false; status: 'PROVISIONED' | 'PENDING'; reason?: string }
  | { fault: true };

/** The read-only registry peek's result: who to claim, on which asset. */
interface RegistryPeek {
  assetId: string;
  rightsHolderId: string;
  holderEntry: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function holderEmail(holder: unknown): unknown {
  if (typeof holder !== 'object' || holder === null) return undefined;
  return (holder as { email?: unknown }).email;
}

/**
 * The engine/jurisdiction fields ride beside the drop's validated creator
 * payload; they are UCT-issuance fields, not creator fields, so the route
 * validates them itself (live sanitized-400 semantics). Contained cast: the
 * validator has already proven the body is a record when parsed.ok.
 */
function uctRequestFields(body: unknown): { engine?: unknown; jurisdiction?: unknown } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const { engine, jurisdiction } = body as { engine?: unknown; jurisdiction?: unknown };
  return { engine, jurisdiction };
}

/**
 * Read-only registry peek implementing the ordering invariant: finds the
 * holder entry by normalized email WITHOUT taking the advisory lock or
 * writing anything. The authoritative find-or-create stays inside
 * registerHolder's serialized transaction — a peek that races a concurrent
 * signup merely misroutes to the fresh path, where the transaction
 * re-checks under the lock (and a concurrent same-email signUp resolves to
 * the 409 before the transaction ever runs).
 */
async function peekRegistryHolder(
  db: NonNullable<ReturnType<typeof getDb>>,
  email: string,
): Promise<RegistryPeek | null> {
  const res = await db.query<RegistryRow>(
    `SELECT id, rights_holders
       FROM cbt_assets
      WHERE cbt_code = $1`,
    [SIGNUP_REGISTRY_CBT_CODE],
  );
  if (res.rows.length === 0) return null;
  const stored = res.rows[0].rights_holders;
  if (!Array.isArray(stored)) return null;
  const existing = stored.find((holder) => holderEmail(holder) === email);
  if (existing === undefined) return null;
  const rightsHolderId = (existing as { rightsHolderId?: unknown }).rightsHolderId;
  if (!isNonEmptyString(rightsHolderId)) {
    throw new Error('Signup registry holder entry is missing rightsHolderId.');
  }
  return { assetId: res.rows[0].id, rightsHolderId, holderEntry: existing };
}

/**
 * Mints the UCT inside the caller's transaction: a crypto-random serial is
 * uniqueness-checked against EVERY rights holder across cbt_assets (the
 * advisory lock serializes signups, so check-then-write cannot interleave
 * with another registration), retried on collision, and failed CLOSED when
 * uniqueness is not achieved within bounds.
 */
async function mintUctInTx(tx: TxClient, jurisdiction: string): Promise<string> {
  const year = uctIssuanceYear();
  for (let attempt = 0; attempt < UCT_MINT_ATTEMPTS; attempt += 1) {
    const candidate = buildUct(jurisdiction, year, uctSerial());
    const collision = await tx.query(
      `SELECT 1
         FROM cbt_assets, jsonb_array_elements(rights_holders) AS rh
        WHERE rh @> $1::jsonb
        LIMIT 1`,
      [JSON.stringify({ uct: candidate })],
    );
    if (!collision.rows.length) {
      return candidate;
    }
  }
  throw new UctMintFailedError();
}

/** Internal abort: the serial draw did not achieve uniqueness in bounds. */
class UctMintFailedError extends Error {
  constructor() {
    super('UCT mint did not achieve serial uniqueness');
    this.name = 'UctMintFailedError';
  }
}

/**
 * Find-or-create the signup registry row and the holder entry for the
 * normalized email, in one serialized transaction. The advisory lock makes
 * concurrent first-time signups (same or different email) find-or-create
 * without duplicating entries; FOR UPDATE covers the registry row itself.
 * On the creating path the UCT is minted inside this same transaction.
 */
async function registerHolder(
  db: NonNullable<ReturnType<typeof getDb>>,
  email: string,
  identity: { jurisdiction: string; engine: SignupEngine | null },
): Promise<SignupRegistration> {
  return db.transaction<SignupRegistration>(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SIGNUP_REGISTRY_LOCK]);

    const registryRes = await tx.query<RegistryRow>(
      `SELECT id, rights_holders
         FROM cbt_assets
        WHERE cbt_code = $1
        FOR UPDATE`,
      [SIGNUP_REGISTRY_CBT_CODE],
    );
    let assetId: string;
    let holders: unknown[];
    if (registryRes.rows.length > 0) {
      assetId = registryRes.rows[0].id;
      const stored = registryRes.rows[0].rights_holders;
      if (!Array.isArray(stored)) {
        throw new Error('Signup registry rights_holders is not an array.');
      }
      holders = stored;
    } else {
      const inserted = await tx.query<RegistryRow>(
        `INSERT INTO cbt_assets (cbt_code, title, medium, created_timestamp)
         VALUES ($1, $2, $3, $4)
         RETURNING id, rights_holders`,
        [SIGNUP_REGISTRY_CBT_CODE, SIGNUP_REGISTRY_TITLE, SIGNUP_REGISTRY_MEDIUM, Date.now()],
      );
      assetId = inserted.rows[0].id;
      holders = [];
    }

    const existing = holders.find((holder) => holderEmail(holder) === email);
    if (existing !== undefined) {
      const rightsHolderId = (existing as { rightsHolderId?: unknown }).rightsHolderId;
      if (!isNonEmptyString(rightsHolderId)) {
        throw new Error('Signup registry holder entry is missing rightsHolderId.');
      }
      return { alreadyRegistered: true, assetId, rightsHolderId, holderEntry: existing, minted: null };
    }

    // Mint inside the SAME advisory-lock transaction — race-safe by
    // construction, independent of Increase configuration.
    const minted: MintedUct = {
      uct: await mintUctInTx(tx, identity.jurisdiction),
      uctCreatedAt: new Date().toISOString(),
      jurisdiction: identity.jurisdiction,
      ...(identity.engine ? { engine: identity.engine } : {}),
    };

    // The EXACT PR #26 holder entry shape, with email as the identity field,
    // plus the immutable issuance facts of the creator-root identity.
    const entry = {
      rightsHolderId: randomUUID(),
      name: email,
      role: 'COMPOSER',
      email,
      payoutRouting: {},
      uct: minted.uct,
      uctCreatedAt: minted.uctCreatedAt,
      uctJurisdiction: minted.jurisdiction,
      ...(identity.engine ? { engine: identity.engine } : {}),
    };
    await tx.query(
      `UPDATE cbt_assets
          SET rights_holders = rights_holders || $2::jsonb
        WHERE id = $1`,
      [assetId, JSON.stringify(entry)],
    );
    return { alreadyRegistered: false, assetId, rightsHolderId: entry.rightsHolderId, holderEntry: entry, minted };
  });
}

/**
 * The preserved Increase provisioning block, extracted as a helper so the
 * fresh (201), claim (200), and race-lost (200) paths share one
 * implementation — behavior identical to the pre-merge inline block: a
 * stored virtual account means PROVISIONED; unconfigured Increase
 * credentials mean PENDING / INCREASE_NOT_CONFIGURED (never a 500); a
 * transient Increase failure means PENDING / INCREASE_UNAVAILABLE; anything
 * else is an internal fault the caller sanitizes.
 */
async function runProvisioning(
  db: NonNullable<ReturnType<typeof getDb>>,
  target: { assetId: string; rightsHolderId: string; holderEntry: unknown },
): Promise<ProvisioningOutcome> {
  if (storedVirtualAccount(target.holderEntry)) {
    return { fault: false, status: 'PROVISIONED' };
  }
  const increaseApiKey = process.env.INCREASE_API_KEY;
  const sourceAccountId = process.env.INCREASE_SOURCE_ACCOUNT_ID;
  if (!increaseApiKey || !sourceAccountId) {
    return { fault: false, status: 'PENDING', reason: 'INCREASE_NOT_CONFIGURED' };
  }
  const outcome = await provisionRightsHolderVirtualAccount(db, {
    assetId: target.assetId,
    rightsHolderId: target.rightsHolderId,
    increaseApiKey,
    sourceAccountId,
  });
  if (outcome.status === 'ALREADY_PROVISIONED' || outcome.status === 'PROVISIONED') {
    return { fault: false, status: 'PROVISIONED' };
  }
  if (outcome.status === 'INCREASE_UNAVAILABLE') {
    return { fault: false, status: 'PENDING', reason: 'INCREASE_UNAVAILABLE' };
  }
  // The holder was just registered (or already existed) in the registry
  // row — NOT_FOUND / NOT_PROVISIONABLE / persistence faults are internal
  // failures, sanitized and logged server-side.
  return { fault: true };
}

/** The 200 status-only body — a claim or repeat, never credential material. */
function statusOnlyResponse(
  provisioning: { status: 'PROVISIONED' | 'PENDING'; reason?: string },
  rightsHolderId: string,
  assetId: string,
): Response {
  return Response.json(
    {
      ok: true,
      created: false,
      status: provisioning.status,
      ...(provisioning.reason ? { reason: provisioning.reason } : {}),
      alreadyRegistered: true,
      rightsHolderId,
      assetId,
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'malformed_body', 'Request body must be valid JSON.');
  }

  // The drop's full-payload validation — 9 named codes; only a non-record
  // body is a 400, every field-level failure is a 422.
  const parsed = validateCovnantSignupPayload(body);
  if (!parsed.ok) {
    const status = parsed.code === 'malformed_body' ? 400 : 422;
    return jsonError(status, parsed.code, parsed.message);
  }

  // Engine/jurisdiction (sanitized, never echoed back): engine is validated
  // whenever present; a claim validates the same way but rewrites nothing.
  // An absent engine mints the UCT with no engine attribution — never a
  // fabricated vertical.
  const fields = uctRequestFields(body);
  let engine: SignupEngine | null = null;
  if (fields.engine !== undefined) {
    engine = normalizeEngine(fields.engine);
    if (!engine) {
      return jsonError(400, 'invalid_engine', 'Invalid signup request: engine must be one of the supported engines.');
    }
  }
  let jurisdiction = DEFAULT_UCT_JURISDICTION;
  if (fields.jurisdiction !== undefined) {
    const normalized = normalizeJurisdiction(fields.jurisdiction);
    if (!normalized) {
      return jsonError(400, 'invalid_jurisdiction', 'Invalid signup request: jurisdiction must be a 2-letter ISO 3166 code.');
    }
    jurisdiction = normalized;
  }

  // Per-IP in-memory rate limit (drop's limiter — see the serverless
  // caveat in src/lib/server/rateLimit.ts). Runs after validation so a
  // malformed body never burns the bucket.
  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  const verdict = checkRateLimit(`covnant-signup:${clientIp}`, REGISTER_RATE_LIMIT);
  if (!verdict.ok) {
    return jsonError(429, 'rate_limited', 'Too many registrations from this address. Try again later.');
  }

  // Fail-closed env checks — sanitized 503s, zero state.
  const db = getDb();
  if (!db) {
    return jsonError(503, 'database_not_configured', 'Database is not configured (DATABASE_URL).');
  }
  const env = readSupabaseEnv();
  if (env === null) {
    return jsonError(503, 'supabase_not_configured', 'Supabase credentials are not configured.');
  }
  const clients = { auth: createAuthClient(env), admin: createAdminClient(env) };

  // ORDERING INVARIANT — the registry is read BEFORE signUp.
  let registered: RegistryPeek | null;
  try {
    registered = await peekRegistryHolder(db, parsed.value.email);
  } catch (error) {
    console.error('Signup registry lookup failed:', error);
    return jsonError(500, 'registration_failed', 'Signup registration failed.');
  }

  if (registered !== null) {
    // REGISTRY HIT — claim (no auth yet) or duplicate (auth exists); signUp
    // itself decides. A claim creates the account + profile and discloses
    // NOTHING but status: no second UCT mint, no registry rewrite.
    const claim = await registerCovnantCreator(parsed.value, clients);
    if (!claim.ok) {
      return jsonError(claim.status, claim.code, claim.message);
    }
    const provisioning = await runProvisioning(db, {
      assetId: registered.assetId,
      rightsHolderId: registered.rightsHolderId,
      holderEntry: registered.holderEntry,
    });
    if (provisioning.fault) {
      await compensateCovnantSignup(clients.admin, claim.value.user.id, 'provisioning_fault');
      console.error('Signup provisioning fault on the claim path.');
      return jsonError(500, 'provisioning_failed', 'Signup could not complete provisioning.');
    }
    return statusOnlyResponse(provisioning, registered.rightsHolderId, registered.assetId);
  }

  // FRESH EMAIL — the full 201 flow. Auth + profile first, then the
  // registry transaction (the UCT mints inside it), then provisioning.
  const auth = await registerCovnantCreator(parsed.value, clients);
  if (!auth.ok) {
    return jsonError(auth.status, auth.code, auth.message);
  }

  let registration: SignupRegistration;
  try {
    registration = await registerHolder(db, parsed.value.email, { jurisdiction, engine });
  } catch (error) {
    // COMPENSATION INVARIANT — the registry/UCT stage failed after the auth
    // signup committed: delete the profile row + auth user so nothing is
    // registered (fail-closed, clean-retryable), then surface the live
    // fail-closed semantics unchanged.
    await compensateCovnantSignup(clients.admin, auth.value.user.id, 'registry_stage_failed');
    if (error instanceof UctMintFailedError) {
      // Fail-closed: no UCT, no registration. Sanitized — no serial details.
      console.error('Signup UCT mint failed after bounded retries.');
      return jsonError(503, 'UCT_MINT_FAILED', 'Signup could not mint a UCT.');
    }
    console.error('Signup registration failed:', error);
    return jsonError(500, 'registration_failed', 'Signup registration failed.');
  }

  const provisioning = await runProvisioning(db, {
    assetId: registration.assetId,
    rightsHolderId: registration.rightsHolderId,
    holderEntry: registration.holderEntry,
  });
  if (provisioning.fault) {
    await compensateCovnantSignup(clients.admin, auth.value.user.id, 'provisioning_fault');
    console.error('Signup provisioning fault on the fresh path.');
    return jsonError(500, 'provisioning_failed', 'Signup could not complete provisioning.');
  }

  // Status fields only — NEVER accountNumber/routingNumber/accountNumberId,
  // provisioned or pending. Real numbers surface post-login only.
  // The UCT is disclosed ONLY on the creating (201) response: a 200 carries
  // NO uct key (enumeration protection, test-asserted). session/user/profile
  // ride the 201 union only — a 200 never discloses credential material.
  const minted = registration.minted;
  const created = !registration.alreadyRegistered;
  return Response.json(
    {
      ok: true,
      created,
      ...(minted
        ? {
            uct: minted.uct,
            uctCreatedAt: minted.uctCreatedAt,
            jurisdiction: minted.jurisdiction,
            ...(minted.engine ? { engine: minted.engine } : {}),
          }
        : {}),
      status: provisioning.status,
      ...(provisioning.reason ? { reason: provisioning.reason } : {}),
      alreadyRegistered: registration.alreadyRegistered,
      rightsHolderId: registration.rightsHolderId,
      assetId: registration.assetId,
      ...(created
        ? {
            session: auth.value.session,
            user: auth.value.user,
            profile: auth.value.profile,
          }
        : {}),
    },
    { status: created ? 201 : 200, headers: { 'cache-control': 'no-store' } },
  );
}

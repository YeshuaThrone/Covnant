/**
 * POST /api/covnant/auth/signup — CovnantRoyaltyTrackingAPI instant sign-up.
 *
 * Purpose: register a self-serve rights holder from nothing but an email
 * address, then trigger the SAME Increase virtual-account provisioning flow
 * the provision route runs — through the shared core in
 * src/lib/covnant/provisioning.ts (no internal HTTP self-calls).
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
 * name starts as the email (the only data a signup carries) and
 * payoutRouting starts empty — the creator has no external bank or virtual
 * account yet. Provisioning fills payoutRouting.covenantVirtualAccount
 * exactly per the existing contract.
 *
 * Fail-closed verification (product requirement): when INCREASE_API_KEY or
 * INCREASE_SOURCE_ACCOUNT_ID is unconfigured, signup STILL succeeds —
 * 201 first registration / 200 idempotent — with provisioning status
 * 'PENDING' plus a machine-readable reason ('INCREASE_NOT_CONFIGURED';
 * 'INCREASE_UNAVAILABLE' when Increase itself fails transiently). NEVER a
 * 500 for those. Unconfigured DATABASE_URL stays fail-closed 503.
 *
 * CRITICAL SAFETY: signup responses carry STATUS FIELDS ONLY — never
 * accountNumber, routingNumber, or accountNumberId, provisioned or not.
 * A PENDING response must never carry placeholder numbers a creator could
 * point real payouts at; real numbers surface only through the
 * authenticated product surfaces (the provision route contract).
 *
 * Idempotency + recovery: repeat signup with the same normalized email
 * returns the existing holder (no duplicate entry) and re-triggers
 * provisioning when still PENDING — so once credentials are set, a repeat
 * signup completes provisioning through the idempotent, race-safe core.
 *
 * Scope guards: this route never reads or writes universal_royalty_ledger
 * (zero money movement), touches no Supabase auth-user machinery (PR #11's
 * /api/users/register owns that — this endpoint registers the rights
 * holder only), and adds no env vars. Caller authentication: none,
 * consistent with the locked v1 server-side posture of the Covnant
 * routes; abuse-hardening (rate limiting / allowlist) is deferred as a
 * dev-phase non-goal.
 *
 * UCT (Universal Covnant Tag — the creator-root identity; the canonical
 * Generation 8 expansion of "the universal root identity that follows the
 * creator everywhere; the ultimate fallback that tracks and claims the
 * creator's assets globally"): a CREATING
 * signup also mints UCT-[JURISDICTION]-[YEAR]-[SERIAL]-[CHECKSUM] inside
 * the SAME advisory-lock transaction — issuance is race-safe by
 * construction and independent of Increase configuration. The request
 * gains `engine` (validated whenever present; any non-member value is a
 * sanitized 400) and optional `jurisdiction` (2-char ISO 3166, default
 * "US"); the shipped { email }-only shape stays accepted so the PR #27
 * contract passes unchanged (its tests pin that exact shape), and an
 * absent engine is recorded as NO engine attribution — never fabricated.
 * Issuance facts persist immutably on the holder entry (uct, uctCreatedAt,
 * uctJurisdiction, engine). DISCLOSURE: the UCT is returned ONLY on the
 * creating 201 response; an idempotent repeat is status-only and carries
 * NO uct key (enumeration protection — an email is never an oracle for
 * someone else's UCT). The serial is crypto-random and uniqueness-checked
 * with bounded retry; failure is fail-closed 503 UCT_MINT_FAILED. The
 * checksum is integrity-only — not a secret, not an auth factor.
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

export const dynamic = 'force-dynamic';

/** Designated registry row anchoring self-serve identity (see header). */
const SIGNUP_REGISTRY_CBT_CODE = 'CBT-SIGNUP-REGISTRY';
const SIGNUP_REGISTRY_TITLE = 'Covnant Instant Sign-Up';
const SIGNUP_REGISTRY_MEDIUM = 'SIGNUP_REGISTRY';
/** Advisory-lock key serializing registry find-or-create across signups. */
const SIGNUP_REGISTRY_LOCK = 'covnant-signup-registry';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Bounded serial-uniqueness retries before the mint fails closed. */
const UCT_MINT_ATTEMPTS = 3;

/** Connection-scoped query surface handed to a db.transaction callback. */
type TxClient = Parameters<Parameters<Db['transaction']>[0]>[0];

interface SignupRequestBody {
  email?: unknown;
  engine?: unknown;
  jurisdiction?: unknown;
}

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
  /** Null on the idempotent-repeat path — the repeat never carries a UCT. */
  minted: MintedUct | null;
}

function jsonError(error: string, status: number, reason?: string): Response {
  return Response.json(
    { ok: false, error, ...(reason ? { reason } : {}) },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/** Internal abort: the serial draw did not achieve uniqueness in bounds. */
class UctMintFailedError extends Error {
  constructor() {
    super('UCT mint did not achieve serial uniqueness');
    this.name = 'UctMintFailedError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Trims, lowercases, and validates; null when the input is not an email. */
function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254) return null;
  const at = email.indexOf('@');
  if (at < 1 || at > 64) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}

function holderEmail(holder: unknown): unknown {
  if (typeof holder !== 'object' || holder === null) return undefined;
  return (holder as { email?: unknown }).email;
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

export async function POST(request: Request): Promise<Response> {
  let body: SignupRequestBody;
  try {
    body = (await request.json()) as SignupRequestBody;
  } catch {
    return jsonError('Signup requires a JSON body with an email address.', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError('Signup requires a JSON body with an email address.', 400);
  }
  const email = normalizeEmail(body.email);
  if (!email) {
    return jsonError('Invalid signup request: provide a valid email address.', 400);
  }

  // Engine/jurisdiction (sanitized, never echoed back): engine is validated
  // whenever present; the shipped { email }-only shape stays accepted so
  // every PR #27 behavior passes unchanged. An absent engine mints the UCT
  // with no engine attribution — never a fabricated vertical.
  let engine: SignupEngine | null = null;
  if (body.engine !== undefined) {
    engine = normalizeEngine(body.engine);
    if (!engine) {
      return jsonError('Invalid signup request: engine must be one of the supported engines.', 400);
    }
  }
  let jurisdiction = DEFAULT_UCT_JURISDICTION;
  if (body.jurisdiction !== undefined) {
    const normalized = normalizeJurisdiction(body.jurisdiction);
    if (!normalized) {
      return jsonError('Invalid signup request: jurisdiction must be a 2-letter ISO 3166 code.', 400);
    }
    jurisdiction = normalized;
  }

  const db = getDb();
  if (!db) {
    return jsonError('Database is not configured (DATABASE_URL).', 503);
  }

  let registration: SignupRegistration;
  try {
    registration = await registerHolder(db, email, { jurisdiction, engine });
  } catch (error) {
    if (error instanceof UctMintFailedError) {
      // Fail-closed: no UCT, no registration. Sanitized — no serial details.
      console.error('Signup UCT mint failed after bounded retries.');
      return jsonError('Signup could not mint a UCT.', 503, 'UCT_MINT_FAILED');
    }
    console.error('Signup registration failed:', error);
    return jsonError('Signup registration failed.', 500);
  }

  // Provisioning trigger — the SAME flow as the provision route, via the
  // shared core. Unconfigured Increase credentials leave provisioning
  // PENDING instead of failing the signup; the registration has already
  // committed either way.
  let provisioningStatus: 'PROVISIONED' | 'PENDING';
  let pendingReason: string | undefined;
  if (storedVirtualAccount(registration.holderEntry)) {
    provisioningStatus = 'PROVISIONED';
  } else {
    const increaseApiKey = process.env.INCREASE_API_KEY;
    const sourceAccountId = process.env.INCREASE_SOURCE_ACCOUNT_ID;
    if (!increaseApiKey || !sourceAccountId) {
      provisioningStatus = 'PENDING';
      pendingReason = 'INCREASE_NOT_CONFIGURED';
    } else {
      const outcome = await provisionRightsHolderVirtualAccount(db, {
        assetId: registration.assetId,
        rightsHolderId: registration.rightsHolderId,
        increaseApiKey,
        sourceAccountId,
      });
      if (outcome.status === 'ALREADY_PROVISIONED' || outcome.status === 'PROVISIONED') {
        provisioningStatus = 'PROVISIONED';
      } else if (outcome.status === 'INCREASE_UNAVAILABLE') {
        provisioningStatus = 'PENDING';
        pendingReason = 'INCREASE_UNAVAILABLE';
      } else {
        // The holder was just registered (or already existed) in the
        // registry row — NOT_FOUND / NOT_PROVISIONABLE / persistence faults
        // are internal failures, sanitized and logged server-side.
        console.error('Signup provisioning fault:', outcome.status);
        return jsonError('Signup could not complete provisioning.', 500);
      }
    }
  }

  // Status fields only — NEVER accountNumber/routingNumber/accountNumberId,
  // provisioned or pending. Real numbers surface post-login only.
  // The UCT is disclosed ONLY on the creating (201) response: an idempotent
  // repeat carries NO uct key (enumeration protection, test-asserted).
  const minted = registration.minted;
  return Response.json(
    {
      ok: true,
      created: !registration.alreadyRegistered,
      ...(minted
        ? {
            uct: minted.uct,
            uctCreatedAt: minted.uctCreatedAt,
            jurisdiction: minted.jurisdiction,
            ...(minted.engine ? { engine: minted.engine } : {}),
          }
        : {}),
      status: provisioningStatus,
      ...(pendingReason ? { reason: pendingReason } : {}),
      alreadyRegistered: registration.alreadyRegistered,
      rightsHolderId: registration.rightsHolderId,
      assetId: registration.assetId,
    },
    { status: registration.alreadyRegistered ? 200 : 201, headers: { 'cache-control': 'no-store' } },
  );
}

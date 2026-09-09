/**
 * The seal's signup wire mapping — pure functions, unit-testable without a
 * browser. The component (EntryZones.tsx) owns the fetch and the state;
 * this module owns the contract.
 *
 * Request: POST /api/covnant/auth/signup, the reconciled union contract
 * (art_gOfrFMCA). The landing's combined "Core Industry & Title" input is
 * sent AS CAPTURED for BOTH `core_industry` and `title` — the combined-field
 * ruling stores the full string in core_industry, the validator requires a
 * non-empty title, and the client never splits the value or the zone.
 *
 * Response: every branch of the contract renders. Success bodies are status
 * fields only (never account numbers); errors arrive as
 * { ok: false, error, reason } (src/lib/server/http.ts).
 */

/** The six captured entry values — the seal's own payload shape. */
export type SealEntryValues = {
  stageName: string;
  legalName: string;
  email: string;
  phoneNumber: string;
  password: string;
  coreIndustryTitle: string;
};

export type SignupRequestBody = {
  stage_name: string;
  legal_name: string;
  email: string;
  /** E.164 when captured non-empty; omitted when blank (stored as null). */
  phone?: string;
  core_industry: string;
  title: string;
  password: string;
  /** The seal submit is the acceptance act — always true. */
  udr_terms_accepted: true;
};

/**
 * The combined-field ruling, made explicit: the captured string rides in
 * BOTH fields — core_industry stores the full string; title carries the
 * same captured value because the API requires it (the DB column is
 * nullable, the validator is not). No delimiter guessing, no splitting.
 * A blank phone is omitted entirely (the API stores null).
 */
export function buildSignupPayload(values: SealEntryValues): SignupRequestBody {
  return {
    stage_name: values.stageName,
    legal_name: values.legalName,
    email: values.email,
    ...(values.phoneNumber.trim() === '' ? {} : { phone: values.phoneNumber }),
    core_industry: values.coreIndustryTitle,
    title: values.coreIndustryTitle,
    password: values.password,
    udr_terms_accepted: true,
  };
}

/** The route's provisioning status pair (contract-locked). */
export type ProvisioningStatus = 'PENDING' | 'PROVISIONED';

/**
 * One state per renderable contract branch. `created` is the 201 (the ONLY
 * response that carries the UCT — `uct: null` renders the success state
 * without a tag line); `repeat` is the status-only 200; `invalid` is a coded
 * 4xx validation failure rendering the API's sanitized message; `failed`
 * covers the fail-closed 5xx/network paths, whose messages point at the
 * unseal-and-resubmit recovery (nothing partial ever persists).
 */
export type SealRequestState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | {
      phase: 'created';
      uct: string | null;
      provisioning: ProvisioningStatus;
      sessionless: boolean;
    }
  | { phase: 'repeat'; provisioning: ProvisioningStatus }
  | { phase: 'duplicate' }
  | { phase: 'invalid'; message: string }
  | { phase: 'rate_limited' }
  | { phase: 'failed'; message: string };

/** The UCT_MINT_FAILED recovery line — nothing registered, clean retry. */
export const UCT_MINT_FAILED_MESSAGE =
  'Nothing was registered — unseal and submit again';

/** The network/transport failure line — the request never completed. */
export const NETWORK_FAILED_MESSAGE =
  'Your seal could not reach the registry — unseal and submit again';

/** The generic fail-closed server line. */
export const SERVER_FAILED_MESSAGE =
  'Your seal could not be recorded — unseal and submit again';

const INVALID_FALLBACK_MESSAGE = 'Your entry could not be validated — unseal and correct it';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Unknown statuses normalize to PENDING — the fail-closed reading. */
function provisioningOf(body: Record<string, unknown>): ProvisioningStatus {
  return body.status === 'PROVISIONED' ? 'PROVISIONED' : 'PENDING';
}

/**
 * Map a signup response (status + parsed-or-null body) to the state the
 * seal composition renders. Total: any shape, including garbage, lands in a
 * renderable branch.
 */
export function mapSignupResponse(status: number, body: unknown): SealRequestState {
  if (!isRecord(body)) {
    return { phase: 'failed', message: SERVER_FAILED_MESSAGE };
  }

  if (status === 201) {
    return {
      phase: 'created',
      uct: typeof body.uct === 'string' && body.uct !== '' ? body.uct : null,
      provisioning: provisioningOf(body),
      sessionless: body.session == null,
    };
  }

  if (status === 200) {
    return { phase: 'repeat', provisioning: provisioningOf(body) };
  }

  if (status === 409) {
    return { phase: 'duplicate' };
  }

  if (status === 429) {
    return { phase: 'rate_limited' };
  }

  if (status === 422 || status === 400) {
    return {
      phase: 'invalid',
      message:
        typeof body.error === 'string' && body.error !== ''
          ? body.error
          : INVALID_FALLBACK_MESSAGE,
    };
  }

  if (body.reason === 'UCT_MINT_FAILED') {
    return { phase: 'failed', message: UCT_MINT_FAILED_MESSAGE };
  }

  return { phase: 'failed', message: SERVER_FAILED_MESSAGE };
}

/**
 * The transport-failure state (fetch threw — offline, connection reset).
 * The local seal record already persists; this only renders the recovery.
 */
export function networkFailureState(): SealRequestState {
  return { phase: 'failed', message: NETWORK_FAILED_MESSAGE };
}

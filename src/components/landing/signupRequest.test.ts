import { describe, expect, it } from 'vitest';

import {
  buildSignupPayload,
  extractSignupSession,
  mapSignupResponse,
  networkFailureState,
  NETWORK_FAILED_MESSAGE,
  SERVER_FAILED_MESSAGE,
  UCT_MINT_FAILED_MESSAGE,
  type SealEntryValues,
} from './signupRequest';

/**
 * The seal's wire-contract unit gates — the combined-field ruling, the
 * unconditional terms flag, and a renderable branch for every response the
 * contract defines (plus the total-garbage path).
 */

const VALUES: SealEntryValues = {
  stageName: 'Nova Reign',
  legalName: 'Jordan A. Reyes',
  email: 'Nova@Example.com',
  phoneNumber: '+15125550123',
  password: 'correct-horse-battery',
  coreIndustryTitle: 'Music — Recording',
};

describe('buildSignupPayload', () => {
  it('maps the six seal values onto the contract body with terms true', () => {
    expect(buildSignupPayload(VALUES)).toEqual({
      stage_name: 'Nova Reign',
      legal_name: 'Jordan A. Reyes',
      email: 'Nova@Example.com',
      phone: '+15125550123',
      core_industry: 'Music — Recording',
      title: 'Music — Recording',
      password: 'correct-horse-battery',
      udr_terms_accepted: true,
    });
  });

  it('sends the combined Core Industry & Title AS CAPTURED for both fields', () => {
    // The combined-field ruling: the full string rides in core_industry AND
    // title — no delimiter guessing, no splitting, no second input.
    const body = buildSignupPayload({ ...VALUES, coreIndustryTitle: 'Producer' });
    expect(body.core_industry).toBe('Producer');
    expect(body.title).toBe('Producer');
  });

  it('omits phone entirely when the capture is blank (stored as null)', () => {
    const body = buildSignupPayload({ ...VALUES, phoneNumber: '   ' });
    expect('phone' in body).toBe(false);
  });

  it('never normalizes the captured phone client-side — the API validates E.164', () => {
    const body = buildSignupPayload({ ...VALUES, phoneNumber: '+1 555 010 2030' });
    expect(body.phone).toBe('+1 555 010 2030');
  });
});

describe('mapSignupResponse', () => {
  const CREATED_201 = {
    ok: true,
    created: true,
    uct: 'UCT-US-2026-9A3F02B7-K4',
    uctCreatedAt: '2026-09-09T20:31:04.000Z',
    jurisdiction: 'US',
    status: 'PENDING',
    reason: 'INCREASE_NOT_CONFIGURED',
    alreadyRegistered: false,
    rightsHolderId: 'b2f1c3a9-1111-4222-8333-444455556666',
    assetId: '7e6d5c4b-9999-4888-a777-666555544444',
    session: null,
    user: { id: 'auth_user_1', email: 'artist@example.com', email_confirmed_at: null },
    profile: { id: 'auth_user_1', stage_name: 'Nova Reign' },
  };

  it('maps a session-less 201 to created with the UCT and check-your-inbox', () => {
    expect(mapSignupResponse(201, CREATED_201)).toEqual({
      phase: 'created',
      uct: 'UCT-US-2026-9A3F02B7-K4',
      provisioning: 'PENDING',
      sessionless: true,
    });
  });

  it('maps a 201 carrying a session to created, not session-less', () => {
    expect(mapSignupResponse(201, { ...CREATED_201, session: { access_token: 't' } })).toEqual({
      phase: 'created',
      uct: 'UCT-US-2026-9A3F02B7-K4',
      provisioning: 'PENDING',
      sessionless: false,
    });
  });

  it('maps a 200 status-only repeat to repeat — no uct key to read', () => {
    const body = {
      ok: true,
      created: false,
      status: 'PROVISIONED',
      alreadyRegistered: true,
      rightsHolderId: 'rh',
      assetId: 'asset',
    };
    expect(mapSignupResponse(200, body)).toEqual({
      phase: 'repeat',
      provisioning: 'PROVISIONED',
    });
  });

  it('maps a 409 duplicate_email to duplicate', () => {
    expect(mapSignupResponse(409, { ok: false, error: 'exists', reason: 'duplicate_email' })).toEqual({
      phase: 'duplicate',
    });
  });

  it('maps a coded 422 to invalid carrying the API message', () => {
    const body = {
      ok: false,
      error: 'phone must be an E.164 number (for example +15125550123).',
      reason: 'invalid_phone',
    };
    expect(mapSignupResponse(422, body)).toEqual({
      phase: 'invalid',
      message: 'phone must be an E.164 number (for example +15125550123).',
    });
  });

  it('maps a 429 to rate_limited', () => {
    expect(mapSignupResponse(429, { ok: false, error: 'too many', reason: 'rate_limited' })).toEqual({
      phase: 'rate_limited',
    });
  });

  it('maps a 503 UCT_MINT_FAILED to the clean-retry recovery line', () => {
    expect(mapSignupResponse(503, { ok: false, error: 'mint', reason: 'UCT_MINT_FAILED' })).toEqual({
      phase: 'failed',
      message: UCT_MINT_FAILED_MESSAGE,
    });
  });

  it('maps any other fail-closed 5xx to the generic recovery line', () => {
    expect(mapSignupResponse(503, { ok: false, error: 'db', reason: 'database_not_configured' })).toEqual({
      phase: 'failed',
      message: SERVER_FAILED_MESSAGE,
    });
  });

  it('is total — a non-JSON body lands in the failed branch, never a throw', () => {
    expect(mapSignupResponse(200, null)).toEqual({ phase: 'failed', message: SERVER_FAILED_MESSAGE });
    expect(mapSignupResponse(201, 'nope')).toEqual({ phase: 'failed', message: SERVER_FAILED_MESSAGE });
  });
});

describe('networkFailureState', () => {
  it('renders the transport recovery line', () => {
    expect(networkFailureState()).toEqual({ phase: 'failed', message: NETWORK_FAILED_MESSAGE });
  });
});

describe('extractSignupSession — the 201 session-capture point', () => {
  it('extracts non-empty access and refresh tokens from a carrying body', () => {
    expect(
      extractSignupSession({ session: { access_token: 'at', refresh_token: 'rt' } }),
    ).toEqual({ accessToken: 'at', refreshToken: 'rt' });
  });

  it('fails closed to null on absent, malformed, or empty token fields', () => {
    expect(extractSignupSession(null)).toBeNull();
    expect(extractSignupSession({})).toBeNull();
    expect(extractSignupSession({ session: null })).toBeNull();
    expect(extractSignupSession({ session: 'nope' })).toBeNull();
    expect(extractSignupSession({ session: { refresh_token: 'rt' } })).toBeNull();
    expect(extractSignupSession({ session: { access_token: '', refresh_token: 'rt' } })).toBeNull();
    expect(extractSignupSession({ session: { access_token: 5, refresh_token: 'rt' } })).toBeNull();
  });
});

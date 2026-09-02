import { describe, it, expect, beforeEach } from 'vitest';
import { POST } from '../route';
import { listLedger } from '@/lib/ledger/store';

/**
 * PR 4 — claims webhook contract tests (memory mode).
 *
 * The vendored `processUniversalSocialWebhookAction` builds a FRESH SDK instance
 * per call with no DB client when Supabase env vars are unset, so every claim
 * fails asset resolution in memory mode ("not found in engine memory and no DB
 * client supplied"). These tests pin the route's contract around that behavior:
 * strict body validation up front, a 502 pass-through of the engine error (never
 * a silent 200), and no ledger writes on failure. DB-mode upsert behavior is
 * covered by the engine and the ledger store tests.
 */

const validClaim = {
  platform: 'SPOTIFY',
  cbtCode: 'CBT-TRK-TEST000010',
  externalAssetId: 'spotify:track:1234',
  mediaContentId: 'vid-1',
  channelOrProfileId: 'channel-1',
  grossAdRevenueOrRoyalty: 120.5,
  currency: 'USD',
  territoryCountryCode: 'US',
  timestamp: 1_720_000_000_000,
};

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('https://covnant.example/api/webhooks/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  delete (globalThis as { __covnantLedgerIndex?: unknown }).__covnantLedgerIndex;
});

describe('POST /api/webhooks/claims', () => {
  it('rejects non-JSON bodies with 400', async () => {
    const res = await post('not-json{');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it('rejects claims arrays that are missing, empty, or malformed with 400', async () => {
    for (const body of [{}, { claims: [] }, { claims: [{ platform: 'SPOTIFY' }] }]) {
      const res = await post(body as unknown);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/GlobalMatchClaimPayload/);
    }
  });

  it('rejects claims with non-positive or non-numeric gross amounts with 400', async () => {
    const res = await post({
      claims: [{ ...validClaim, grossAdRevenueOrRoyalty: 0 }],
    });
    expect(res.status).toBe(400);
  });

  it('returns 502 with the engine error and writes nothing when no asset resolves', async () => {
    const res = await post({ claims: [validClaim] });

    // Memory mode: the action's fresh SDK cannot resolve the asset.
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/could not be resolved|not found/i);
    expect(await listLedger()).toHaveLength(0);
  });
});

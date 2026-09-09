import { describe, expect, it, vi } from 'vitest';
import { allowlistsSummary, contractsSummary, registrySummary } from '../overview';

/**
 * Overview aggregation tests — pure transforms, no I/O. The load-bearing pin
 * is the disclosure rule: the registry summary carries PROVISIONING STATUS
 * ONLY — no payoutRouting object, no account or routing numbers can leak
 * into the console response. Plus the dedupe/fold behaviors the summaries
 * promise.
 */

function asset(holders: unknown[]): unknown {
  return { cbtCode: 'CBT-X-01', rightsHolders: holders };
}

function holder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rightsHolderId: 'rh_1',
    name: 'Nova Reign',
    role: 'COMPOSER',
    email: 'nova@example.com',
    uct: 'UCT-US-2026-9F3A7C21',
    payoutRouting: {},
    ...overrides,
  };
}

describe('registrySummary — provisioning status ONLY', () => {
  it('marks holders PROVISIONED only when a covenant virtual account exists', () => {
    const summary = registrySummary([
      asset([
        holder({ payoutRouting: { covenantVirtualAccount: { id: 'va_1' } } }),
        holder({ rightsHolderId: 'rh_2' }),
      ]),
    ] as never);

    expect(summary.rightsHolderCount).toBe(2);
    expect(summary.holders[0]).toMatchObject({ rightsHolderId: 'rh_1', provisioning: 'PROVISIONED' });
    expect(summary.holders[1]).toMatchObject({ rightsHolderId: 'rh_2', provisioning: 'PENDING' });
  });

  it('never discloses the routing object or any account/routing number', () => {
    const summary = registrySummary([
      asset([holder({ payoutRouting: { accountNumber: '987654321', routingNumber: '101050001' } })]),
    ] as never);
    const text = JSON.stringify(summary);
    expect(text).not.toContain('payoutRouting');
    expect(text).not.toContain('accountNumber');
    expect(text).not.toContain('routingNumber');
    expect(text).not.toContain('987654321');
    expect(text).not.toContain('101050001');
  });

  it('deduplicates a holder across assets (first appearance wins) and skips id-less entries', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = registrySummary([
        asset([holder({ name: 'First' }), holder({ rightsHolderId: null })]),
        asset([holder({ name: 'Duplicate' })]),
      ] as never);
      expect(summary.rightsHolderCount).toBe(1);
      expect(summary.holders[0].name).toBe('First');
      expect(summary.assetCount).toBe(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('contractsSummary / allowlistsSummary — folds', () => {
  it('folds contract statuses', () => {
    const contracts = [
      { status: 'DRAFT' },
      { status: 'FINAL' },
      { status: 'FINAL' },
    ] as never[];
    expect(contractsSummary(contracts)).toEqual({ total: 3, byStatus: { DRAFT: 1, FINAL: 2 } });
  });

  it('folds allowlist statuses', () => {
    const rows = [{ status: 'ACTIVE' }, { status: 'REVOKED' }, { status: 'ACTIVE' }] as never[];
    expect(allowlistsSummary(rows)).toEqual({ total: 3, byStatus: { ACTIVE: 2, REVOKED: 1 } });
  });
});

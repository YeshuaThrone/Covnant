import { describe, expect, it } from 'vitest';
import {
  BACKUP_WITHHOLDING_BPS,
  BAAS_WEBHOOK_EVENTS,
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  DEFAULT_RECOUPMENT_BPS,
  DSP_WEBHOOK_EVENTS,
  JOURNAL_KINDS,
  VAULT_BUCKETS,
  vaultGlAccount,
} from '../constants';

/**
 * Don Engine locked-constant sanity (Gen 14 foundation).
 *
 * These are the locked financial semantics from the Cursor handoff: split
 * math, backup withholding, dust routing, recoupment, and GL wiring all
 * read them. A drift here silently corrupts every downstream engine PR, so
 * the tests pin exact wire values instead of loose truthiness checks.
 */
describe('don constants', () => {
  it('pins the bps denominator to 10000 (100% in basis points)', () => {
    expect(BPS_DENOMINATOR).toBe(10_000);
  });

  it('pins backup withholding to 2400 bps (24%)', () => {
    expect(BACKUP_WITHHOLDING_BPS).toBe(2_400);
  });

  it('routes company dust to the platform payee, never a creator', () => {
    expect(COMPANY_VARIANCE_PAYEE_ID).toBe('platform');
    expect(COMPANY_VARIANCE_PAYEE_NAME).toBe('Don Engine Variance');
  });

  it('defaults recoupment to a full 10000 bps sweep', () => {
    expect(DEFAULT_RECOUPMENT_BPS).toBe(10_000);
  });

  it('pins the BaaS payout webhook event list', () => {
    expect([...BAAS_WEBHOOK_EVENTS]).toEqual([
      'payout.settled',
      'payout.returned',
      'payout.failed',
    ]);
  });

  it('pins the DSP royalty webhook event list', () => {
    expect([...DSP_WEBHOOK_EVENTS]).toEqual([
      'royalty.report',
      'royalty.adjusted',
      'royalty.reversed',
    ]);
  });

  it('pins the journal kind registry and vault buckets', () => {
    expect([...JOURNAL_KINDS]).toEqual([
      'royalty_ingest',
      'pending_release',
      'payout_hold',
      'payout_settled',
      'payout_failed_reversal',
      'dispute_lock',
      'dispute_unlock',
      'royalty_reversal',
    ]);
    expect([...VAULT_BUCKETS]).toEqual(['available', 'pending', 'reserve']);
  });

  it('maps vault buckets to GL accounts in the drop format', () => {
    expect(vaultGlAccount('creator_1', 'reserve')).toBe('vault:creator_1:reserve');
  });
});

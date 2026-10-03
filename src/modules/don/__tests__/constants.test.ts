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
      'funding_received',
      'unclaimed_holding_post',
      'unclaimed_holding_release',
      'film_escrow_post',
      'film_escrow_release',
      'film_net_points',
      'gaming_cashout_post',
      'gaming_cashout_release',
      'esports_pool_escrow_post',
      'esports_pool_escrow_release',
      'vtuber_holdback_post',
      'vtuber_holdback_release',
      'translation_localization_post',
      'translation_localization_release',
      'ip_option_release',
      // The merch collaboration release (PR 22, the founder merchandise
      // directive): the recoup-then-split settlement's journal kind.
      'merch_collab_release',
      // The merchandise returns reserve + fulfillment confirmation (PR 23,
      // the founder merchandise directive): the gated dispatch journal, the
      // return/chargeback drawdown journal, and the window-release journal.
      'merch_reserve_dispatch',
      'merch_reserve_drawdown',
      'merch_returns_reserve_release',
      // The foreign-tax hold + book returns reserve (PR 27, the founder
      // publishing directive): the straight-into-freeze posting journal,
      // the gated dispatch/drawdown/window-release journals for the
      // per-ISBN reserve, and the book print net's post-offset release.
      'foreign_tax_hold_post',
      'book_reserve_dispatch',
      'book_reserve_drawdown',
      'book_returns_reserve_release',
      'book_print_net_release',
      // The promoter box-office settlement escrow + comedy audio rights
      // (PR 31, the founder tour + live comedy directive): the per-stop
      // escrow posting/release journals and the isolated audio-rights
      // posting journal.
      'promoter_settlement_post',
      'promoter_settlement_release',
      'comedy_audio_rights_post',
      // The brand licensing MG recoupment + audit reserve (PR 33, the
      // founder licensing-enforcement directive): the held royalty's
      // automatic audit-reserve routing, the quarterly-audit/write-off
      // drawdown journal, the verified-reconciliation release journal, and
      // the annual term-close shortfall invoice debit.
      'licensing_audit_reserve_route',
      'licensing_audit_reserve_drawdown',
      'licensing_audit_reserve_release',
      'licensing_mg_shortfall_invoice',
      // The NIL audit escrow + transfer portal clawback (PR 35, the founder
      // NIL-enforcement directive): the 5-10% athletic-department escrow
      // routing/drawdown/release journals and the pro-rated unearned
      // advance's debit hold.
      'nil_audit_escrow_route',
      'nil_audit_escrow_drawdown',
      'nil_audit_escrow_release',
      'nil_unearned_clawback_hold',
      // PR 37 (the founder spatial directive): the spatial commitment
      // journals — escrow route/drawdown/release and the quarterly MSG
      // shortfall invoice — alongside the spatial royalty ingest kinds.
      'spatial_audit_escrow_route',
      'spatial_audit_escrow_drawdown',
      'spatial_audit_escrow_release',
      'spatial_msg_shortfall_invoice',
    ]);
    expect([...VAULT_BUCKETS]).toEqual(['available', 'pending', 'reserve']);
  });

  it('maps vault buckets to GL accounts in the drop format', () => {
    expect(vaultGlAccount('creator_1', 'reserve')).toBe('vault:creator_1:reserve');
  });
});

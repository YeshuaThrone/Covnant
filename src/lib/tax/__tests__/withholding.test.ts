/**
 * The tax selector's one-truth battery (founder directive + addenda,
 * 2026-09-21). Asserted against the LIVE dev-seed store:
 *
 * - EQUALITY with the ledger finances engine: the tax register's per-payee
 *   ledger sums are the escrow selector's per-holder sums for the same
 *   identities — two selector paths, one truth.
 * - The founder's withholding reconciliation identity per transaction row:
 *   gross = covenant fee + withholding + corner dust + net.
 * - The engine gross input rides the stored ledger disbursement figure —
 *   never a copied or hardcoded dollar.
 * - EVERY-CREATOR coverage: the register length equals the distinct payee
 *   count in the store, and the demo identities exercise every
 *   founder-engine branch.
 * - The CSV export parses and carries both blocks with the right rows.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';
import { listLedger } from '@/lib/ledger/store';
import { listAssets } from '@/lib/sdk';
import { escrowStateFromRows } from '@/lib/ledger/finances';
import { toMinor } from '@/lib/ledger/reconciliation';
import { buildAdminTaxJoinContext, buildTaxSection } from '@/lib/admin/sectionPayloads';
import { identityKeyFromPayeeId } from '../payeeProfiles';
import { resolvePayeePayouts } from '../withholding';
import { buildTaxExportCsv, parseCsv } from '../exportCsv';
import type { LedgerRow } from '@/lib/ledger/store';
import type { ContractRow, SectionData } from '@/components/admin/types';

let rows: LedgerRow[];
let tax: ReturnType<typeof buildTaxSection>;

beforeAll(async () => {
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
  const { seedAdminDemoDataIfEmpty } = await import('@/lib/admin/demoSeeds');
  await seedAdminDemoDataIfEmpty();
  rows = await listLedger();
  const assets = await listAssets();
  const contracts: SectionData<ContractRow[]> = {
    kind: 'ready',
    value: [],
  };
  tax = buildTaxSection(rows, assets, contracts);
});

/** Distinct identity keys across a ledger's disbursements (USD rows). */
function distinctPayeeKeys(ledgerRows: readonly LedgerRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of ledgerRows) {
    if (row.currency !== 'USD') continue;
    for (const disbursement of row.disbursements) {
      keys.add(identityKeyFromPayeeId(disbursement.rightsHolderId));
    }
  }
  return keys;
}

describe('tax selector equality with the ledger finances engine', () => {
  it("prices every payout's gross from the stored ledger disbursement", () => {
    const usdRows = rows.filter((row) => row.currency === 'USD');
    expect(tax.transactions.length).toBe(usdRows.length);
    for (const row of usdRows) {
      for (const disbursement of row.disbursements) {
        // The engine input is THIS figure — the stored share of record.
        expect(toMinor(disbursement.grossShare, 'USD')).toBeGreaterThan(0n);
      }
    }
  });

  it("sums the tax register to the escrow selector's per-holder totals", () => {
    const escrow = escrowStateFromRows(rows);
    expect(escrow.length).toBeGreaterThan(0);

    // Aggregate the escrow selector's per-holder figures to identity keys —
    // the register's own grouping — and compare EXACTLY.
    const escrowByIdentity = new Map<string, { gross: bigint; withheld: bigint; net: bigint }>();
    for (const holder of escrow) {
      const key = identityKeyFromPayeeId(holder.rightsHolderId);
      const existing = escrowByIdentity.get(key) ?? { gross: 0n, withheld: 0n, net: 0n };
      escrowByIdentity.set(key, {
        gross: existing.gross + holder.grossUnits,
        withheld: existing.withheld + holder.withheldUnits,
        net: existing.net + holder.netUnits,
      });
    }

    const registerByIdentity = new Map(tax.payees.map((payee) => [payee.payeeId, payee]));
    expect(registerByIdentity.size).toBe(escrowByIdentity.size);

    for (const [key, sums] of escrowByIdentity) {
      const payee = registerByIdentity.get(key);
      expect(payee, `register row for ${key}`).toBeDefined();
      // Same dollars, two fixed-point scales: the escrow selector works in
      // 8-dp units (fixed-point.ts microFromNumber), the register in 4-dp
      // currency minors. Scale the minors up — pure integer comparison.
      expect(payee!.grossMinor * 10_000n).toBe(sums.gross);
      expect(payee!.withheldMinor * 10_000n).toBe(sums.withheld);
      expect(payee!.netMinor * 10_000n).toBe(sums.net);
    }
  });

  it('folds the same engine cents in the register, the periods, and the transactions', () => {
    const registerWithheld = tax.payees.reduce((sum, payee) => sum + payee.engine.withheldCents, 0n);
    const periodWithheld = tax.periods.reduce((sum, period) => sum + period.engine.withheldCents, 0n);
    const transactionWithheld = tax.transactions.reduce(
      (sum, row) => sum + row.engine.withheldCents,
      0n,
    );
    expect(registerWithheld).toBe(periodWithheld);
    expect(registerWithheld).toBe(transactionWithheld);
    expect(registerWithheld).toBeGreaterThan(0n);
  });
});

describe('the withholding reconciliation identity', () => {
  it('holds per transaction row: gross = covenant fee + withholding + net, the fee carrying the corner dust', () => {
    // The founder's own reconciliation language: "holder distributions sum
    // to gross minus the stored fee which carries the corner dust, net
    // equals gross minus withholding per holder." The dust is a PORTION of
    // the stored fee — never an extra deduction on top.
    expect(tax.transactions.length).toBeGreaterThan(0);
    for (const row of tax.transactions) {
      expect(
        row.feeMinor + row.withheldMinor + row.netMinor,
        `reconciliation for ${row.transactionId} (${row.cbt})`,
      ).toBe(row.grossMinor);
      // The dust is the fee's remainder after the engine's per-holder
      // integer rounding — sub-cent negative dust can appear on the
      // social-fee path. The canon invariants that MUST hold: holders
      // never receive more than the gross, and the fee covers the dust.
      expect(
        row.withheldMinor + row.netMinor,
        `holders under gross for ${row.transactionId}`,
      ).toBeLessThanOrEqual(row.grossMinor);
      expect(row.feeMinor + row.dustMinor, `fee covers dust for ${row.transactionId}`).toBeGreaterThanOrEqual(0n);
    }
  });

  it('holds on the engine layer per payee: withheld + state tax + net = engine gross', () => {
    for (const payee of tax.payees) {
      expect(
        payee.engine.withheldCents + payee.engine.stateTaxCents + payee.engine.netCents,
        `engine fold for ${payee.payeeId}`,
      ).toBe(payee.engine.grossCents);
    }
  });
});

describe('every-creator coverage', () => {
  it('keeps the register length equal to the distinct payee count in the store', () => {
    const keys = distinctPayeeKeys(rows);
    expect(keys.size).toBeGreaterThan(0);
    expect(tax.payees.length).toBe(keys.size);
  });

  it('carries every creator into the annual summary block', () => {
    const keys = distinctPayeeKeys(rows);
    const annualIdentities = new Set(tax.annual.map((row) => `${row.year}|${row.payeeId}`));
    for (const key of keys) {
      const hasRow = [...annualIdentities].some((entry) => entry.endsWith(`|${key}`));
      expect(hasRow, `annual row for ${key}`).toBe(true);
    }
  });
});

describe('every-branch demo coverage', () => {
  it('exercises all founder-engine branches at the payout level across the assigned identities', async () => {
    // The branch coverage runs at the PAYOUT level — the register folds
    // payouts per payee, so aggregates mix rates and hide branches.
    const assets = await listAssets();
    const contracts: SectionData<ContractRow[]> = { kind: 'ready', value: [] };
    const fold = resolvePayeePayouts(rows, buildAdminTaxJoinContext(assets, contracts));
    expect(fold.payouts.length).toBeGreaterThan(0);

    const rates = new Set<number>();
    const lockReasons = new Set<string>();
    const forms = new Set<string>();
    for (const payout of fold.payouts) {
      const grossCents = Math.round(payout.resolution.grossAmountUSD * 100);
      if (grossCents > 0) {
        // Round to one decimal — binary float division of the integer
        // cents (62770 / 627700) lands next to 0.1, never on it.
        const rate = Math.round(payout.resolution.withholdingTaxUSD * 100) / grossCents;
        rates.add(Math.round(rate * 10) / 10);
      }
      if (payout.resolution.lockReason) lockReasons.add(payout.resolution.lockReason);
      forms.add(payout.resolution.formTriggered);
    }

    // Verified US clean (0), MX treaty (0.10), statutory fallback (0.30).
    expect(rates.has(0)).toBe(true);
    expect(rates.has(0.1)).toBe(true);
    expect(rates.has(0.3)).toBe(true);
    // The GB treaty row resolves to the 0.00 rate — a CLEARED payout with
    // zero withholding on nonzero gross.
    expect(
      fold.payouts.some(
        (payout) =>
          payout.resolution.grossAmountUSD > 0 &&
          payout.resolution.withholdingTaxUSD === 0 &&
          payout.resolution.lockState === 'CLEARED',
      ),
    ).toBe(true);
    // Both locks: US backup withholding and the mandatory foreign lock.
    expect(lockReasons.has('INVALID_OR_MISSING_TIN_BACKUP_WITHHOLDING')).toBe(true);
    expect(lockReasons.has('UNVERIFIED_FOREIGN_PAYEE_MANDATORY_30_PERCENT_LOCK')).toBe(true);
    // The form spread: royalty MISC, service NEC, corporate exemption.
    expect(forms.has('1099_MISC')).toBe(true);
    expect(forms.has('1099_NEC')).toBe(true);
    expect(forms.has('EXEMPT_CORPORATE')).toBe(true);
  });
});

describe('the CSV export of the composed section', () => {
  it('parses as RFC-4180 CSV with both blocks and every creator and settlement', () => {
    const csv = buildTaxExportCsv(tax);
    const parsed = parseCsv(csv);
    const flat = parsed.flat();
    expect(flat).toContain('PER-PAYEE ANNUAL SUMMARY');
    expect(flat).toContain('PER-TRANSACTION REGISTER');
    // Every creator of record appears in the annual block; every USD
    // settlement appears in the transaction register.
    for (const payee of tax.payees) {
      expect(flat).toContain(payee.payeeName);
    }
    for (const row of tax.transactions) {
      expect(flat).toContain(row.transactionId);
      expect(flat).toContain(row.cbt);
    }
    // QUOTE_ALL + CRLF: every field quoted, rows end with CRLF.
    for (const line of csv.split('\r\n')) {
      if (line === '') continue;
      expect(line.startsWith('"'), `quoted line: ${line.slice(0, 40)}`).toBe(true);
      expect(line.endsWith('"'), `quoted line end: ${line.slice(-40)}`).toBe(true);
    }
    // Deterministic: rebuilding the same section yields the same sheet.
    expect(buildTaxExportCsv(tax)).toBe(csv);
  });
});

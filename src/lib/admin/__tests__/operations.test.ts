/**
 * Focused Operations derivation tests — the dev seed booted live at this
 * commit, every money figure a bigint pin, every view pinned to the engine
 * that owns its numbers (spec art_Eis55ifL verification criteria):
 *
 *   - escrow holders  ⇔ escrowBalanceForHolder (the withdraw-route engine)
 *   - runs            ⇔ the platformRevenueStreams journal fold
 *   - queue groups    ⇔ reconcileLedger / resolvePayeePayouts / the match queue
 *   - registry joins  ⇔ identityKeyFromPayeeId + the master-store tables
 *
 * Seed expectations were re-derived from the live dev seed at this commit
 * (the scouts' origin-main numbers are stale by design).
 */
process.env.DON_DEV_SEED = '1';

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createSeededStore } from '@/lib/server/devSeed';
import { seedDemoSettlementsIfEmpty } from '@/lib/admin/demoSeeds';
import { listLedger, type LedgerRow } from '@/lib/ledger/store';
import { listAssets } from '@/lib/sdk';
import { reconcileLedger } from '@/lib/ledger/reconciliation';
import { escrowStateFromRows } from '@/lib/ledger/finances';
import { escrowBalanceForHolder, UNVERIFIED_FALLBACK_TAX_PROFILE } from '@/lib/escrow/balance';
import { resolvePayeePayouts, foldResolutions, type TaxJoinContext } from '@/lib/tax/withholding';
import { identityKeyFromPayeeId } from '@/lib/tax/payeeProfiles';
import { UCT_DEMO_IDENTITIES } from '@/lib/master/masterStore';
import { operationsFlows, type OperationsFlows } from '@/lib/admin/operations';
import { JOURNAL_KINDS } from '@/modules/don/constants';
import type { Store } from '@/lib/server/store';
import type { CovenantBlockAsset } from '@/engine/covenant-master-sdk';

/** The empty join context — locks do not depend on joins (the Tax tab's own empty-joins behavior). */
const EMPTY_JOINS: TaxJoinContext = {
  entityTypeByCbt: new Map(),
  templateByCbt: new Map(),
  eventStateByCbt: new Map(),
};

let store: Store;
let ledgerRows: LedgerRow[];
let assets: CovenantBlockAsset[];
let flows: OperationsFlows;

beforeAll(async () => {
  store = await createSeededStore();
  await seedDemoSettlementsIfEmpty();
  ledgerRows = await listLedger();
  assets = await listAssets();
  const result = await operationsFlows({
    store,
    ledgerRows,
    assets,
    taxJoinContext: EMPTY_JOINS,
    creatorProfiles: null, // no profile store under the local dev seed
  });
  expect(result).not.toBeNull();
  flows = result as OperationsFlows;
}, 120_000);

describe('Operations · escrow & settlements', () => {
  it('carries the two seeded vaults with bigint buckets of record', () => {
    const founder = flows.escrowSettlements.vaults.find((v) => v.payeeName === 'Yeshua Throne');
    const label = flows.escrowSettlements.vaults.find((v) => v.payeeName === 'Thrones Rights Group');
    expect(founder).toBeDefined();
    expect(label).toBeDefined();
    // Founder vault — the demo-portfolio canon (available / pending / reserve).
    expect(founder!.availableCents).toBe(330_000_000n);
    expect(founder!.pendingCents).toBe(65_000_000n);
    expect(founder!.reserveCents).toBe(100_000_000_000n);
    // Label vault — every royalty run's label credits sit in pending.
    expect(label!.availableCents).toBe(0n);
    expect(label!.pendingCents).toBe(427_843_706_668n);
    expect(label!.reserveCents).toBe(0n);
    // All money fields are bigints, no floats anywhere.
    for (const vault of flows.escrowSettlements.vaults) {
      expect(typeof vault.availableCents).toBe('bigint');
      expect(typeof vault.pendingCents).toBe('bigint');
      expect(typeof vault.reserveCents).toBe('bigint');
      expect(typeof vault.inFlightHoldCents).toBe('bigint');
    }
  });

  it('pins the in-flight payout holds to the store sum', async () => {
    for (const vault of flows.escrowSettlements.vaults) {
      const expected = await store.sumInFlightPayoutHolds(vault.payeeId);
      expect(vault.inFlightHoldCents).toBe(BigInt(expected));
    }
    const founder = flows.escrowSettlements.vaults.find((v) => v.payeeName === 'Yeshua Throne');
    expect(founder!.inFlightHoldCents).toBe(65_000_000n);
  });

  it('reports the four BaaS transfers and no dispute freezes', () => {
    expect(flows.escrowSettlements.transfers).toHaveLength(4);
    for (const transfer of flows.escrowSettlements.transfers) {
      expect(typeof transfer.amountCents).toBe('bigint');
      expect(transfer.provider).toBeDefined();
      expect(transfer.rail).toBeDefined();
      expect(transfer.status).toBeDefined();
    }
    for (const vault of flows.escrowSettlements.vaults) {
      expect(vault.dispute).toBeNull();
    }
  });

  it('equals escrowBalanceForHolder for every rights holder, with the tax-profile source disclosed', () => {
    const states = escrowStateFromRows(ledgerRows);
    expect(flows.escrowSettlements.escrowHolders).toHaveLength(states.length);
    const disbursementsByRow = ledgerRows.map((row) => row.disbursements as unknown[]);
    for (const row of flows.escrowSettlements.escrowHolders) {
      const state = states.find((s) => s.rightsHolderId === row.rightsHolderId);
      expect(state).toBeDefined();
      // Stored record layer — the escrow-state fold verbatim.
      expect(row.storedGrossUnits).toBe(state!.grossUnits);
      expect(row.storedWithheldUnits).toBe(state!.withheldUnits);
      expect(row.storedNetUnits).toBe(state!.netUnits);
      expect(row.paidOutUnits).toBe(state!.paidOutUnits);
      // Engine layer — the withdraw-route balance engine, with the profile
      // of record the payload itself declares.
      let profile = null as null | import('@/engine/covenant-master-sdk').TaxProfile;
      for (const asset of assets) {
        const holder = asset.rightsHolders.find((h) => h.id === row.rightsHolderId);
        if (holder) profile = holder.taxProfile;
      }
      expect(row.taxProfileSource).toBe(profile === null ? 'unverified-fallback' : 'registry');
      const balance = escrowBalanceForHolder({
        disbursementsByRow,
        rightsHolderId: row.rightsHolderId,
        taxProfile: profile ?? UNVERIFIED_FALLBACK_TAX_PROFILE,
      });
      expect(row.engineGrossUnits).toBe(balance.grossUnits);
      expect(row.engineTaxWithheldUnits).toBe(balance.taxWithheldUnits);
      expect(row.enginePreviousPayoutUnits).toBe(balance.previousPayoutUnits);
      expect(row.engineAvailableUnits).toBe(balance.availableUnits);
    }
  });

  it('summarizes all eight canon journal kinds with zero rows honest', () => {
    const movements = flows.escrowSettlements.journalMovements;
    expect(movements.map((m) => m.kind)).toEqual([...JOURNAL_KINDS]);
    const byKind = new Map(movements.map((m) => [m.kind, m]));
    // Re-derived seed expectations (the journal counts of record).
    expect(byKind.get('royalty_ingest')!.journalCount).toBe(119);
    expect(byKind.get('pending_release')!.journalCount).toBe(1);
    expect(byKind.get('payout_hold')!.journalCount).toBe(4);
    expect(byKind.get('payout_settled')!.journalCount).toBe(2);
    // Zero-journal kinds are real zero rows, not absent ones.
    for (const movement of movements) {
      if (!(JOURNAL_KINDS as readonly string[]).includes(movement.kind)) continue;
      if (movement.journalCount === 0) {
        expect(movement.creditCents).toBe(0n);
        expect(movement.debitCents).toBe(0n);
        expect(movement.latestDay).toBeNull();
      }
    }
  });

  it('folds journal credits/debits exactly from the GL entries', async () => {
    const entries = await store.listGlEntries();
    const creditByKind = new Map<string, bigint>();
    const debitByKind = new Map<string, bigint>();
    const journals = await store.listGlJournals();
    const kindByJournal = new Map(journals.map((j) => [j.id, j.kind]));
    for (const entry of entries) {
      const kind = kindByJournal.get(entry.journal_id);
      if (kind === undefined) continue;
      creditByKind.set(kind, (creditByKind.get(kind) ?? 0n) + BigInt(entry.credit_cents));
      debitByKind.set(kind, (debitByKind.get(kind) ?? 0n) + BigInt(entry.debit_cents));
    }
    for (const movement of flows.escrowSettlements.journalMovements) {
      expect(movement.creditCents).toBe(creditByKind.get(movement.kind) ?? 0n);
      expect(movement.debitCents).toBe(debitByKind.get(movement.kind) ?? 0n);
    }
  });

  it('carries the founder 2026 tax-escrow ledger rows of record', () => {
    const founder = flows.escrowSettlements.vaults.find((v) => v.payeeName === 'Yeshua Throne');
    expect(founder).toBeDefined();
    const rows2026 = flows.escrowSettlements.taxEscrowRows.filter(
      (r) => r.payeeId === founder!.payeeId && r.taxYear === 2026,
    );
    expect(rows2026).toHaveLength(5);
    // Four full-price accruals + one prorated accrual — the seed's of-record
    // rows, pinned order-independently.
    const full = rows2026.filter((r) => r.grossCents === 100_000_000_000n);
    const prorated = rows2026.filter((r) => r.grossCents === 16_666_666_668n);
    expect(full).toHaveLength(4);
    expect(prorated).toHaveLength(1);
    for (const row of full) {
      expect(row.withheldCents).toBe(24_000_000_000n);
      expect(row.netCents).toBe(76_000_000_000n);
    }
    expect(prorated[0].withheldCents).toBe(4_000_000_000n);
    expect(prorated[0].netCents).toBe(12_666_666_668n);
    for (const row of rows2026) {
      expect(typeof row.grossCents).toBe('bigint');
      expect(row.tinVerified).toBe(false);
      expect(row.w9OnFile).toBe(false);
      expect(row.requires1099).toBe(true);
    }
    // The of-record flag pattern: exactly one accrual row has crossed the
    // 1099 threshold (the earliest-created row of the five).
    expect(rows2026.filter((r) => r.crossed1099Threshold)).toHaveLength(1);
  });
});

describe('Operations · runs & pipeline health', () => {
  it('equals the journal fold — one row per unique split_run ref', async () => {
    const journals = await store.listGlJournals();
    const runRefs = journals
      .filter((j) => j.kind === 'royalty_ingest' && j.ref_type === 'split_run')
      .map((j) => j.ref_id);
    const uniqueRefs = [...new Set(runRefs)];
    expect(flows.runsPipeline.runs).toHaveLength(uniqueRefs.length);
    expect(flows.runsPipeline.runs).toHaveLength(119);

    const fold = await Promise.all(uniqueRefs.map((id) => store.getSplitRun(id)));
    const foldById = new Map(fold.filter((r) => r !== undefined).map((r) => [r.id, r]));
    for (const row of flows.runsPipeline.runs) {
      const record = foldById.get(row.runId);
      expect(record).toBeDefined();
      expect(row.grossCents).toBe(BigInt(record!.gross_cents));
      expect(row.varianceAccountCents).toBe(BigInt(record!.variance_account_cents));
      expect(row.lineItemCount).toBe(record!.line_item_count);
      expect(row.status).toBe(record!.status);
      expect(typeof row.grossCents).toBe('bigint');
    }
  });

  it('pins the re-derived seed totals — 119 posted runs, zero variance', () => {
    expect(flows.runsPipeline.runs.every((r) => r.status === 'posted')).toBe(true);
    const totalGross = flows.runsPipeline.runs.reduce((sum, r) => sum + r.grossCents, 0n);
    expect(totalGross).toBe(844_510_373_336n);
    const totalVariance = flows.runsPipeline.runs.reduce((sum, r) => sum + r.varianceAccountCents, 0n);
    expect(totalVariance).toBe(0n);
  });

  it('renders the honest empty statement-ingest list', () => {
    expect(flows.runsPipeline.ingests).toEqual([]);
  });

  it('reads the empty match queue as zero counts and an empty quarantine', () => {
    expect(flows.runsPipeline.matchQueue.openCount).toBe(0);
    expect(flows.runsPipeline.matchQueue.matchedCount).toBe(0);
    expect(flows.runsPipeline.matchQueue.discardedCount).toBe(0);
    expect(flows.runsPipeline.matchQueue.openEntries).toEqual([]);
  });
});

describe('Operations · verification-exception queue', () => {
  it('equals the reconciliation engine — 8/8 PASS, designed-empty drift group', () => {
    const engine = reconcileLedger(ledgerRows);
    const group = flows.exceptionQueue.reconciliation;
    expect(group.totalRows).toBe(engine.totalRows);
    expect(group.totalRows).toBe(8);
    expect(group.passCount).toBe(8);
    expect(group.driftCount).toBe(0);
    expect(group.status).toBe('RECONCILED');
    expect(group.driftRows).toEqual([]);
  });

  it('equals the tax engine — two locked payees at the register grain', async () => {
    const fold = resolvePayeePayouts(ledgerRows, EMPTY_JOINS);
    const held = fold.payouts.filter((p) => p.resolution.lockState === 'HELD_IN_TAX_ESCROW');
    expect(held.length).toBe(10);

    // The register's own payee grain — the identity key.
    const heldByIdentity = new Map<string, typeof held>();
    for (const payout of held) {
      const key = identityKeyFromPayeeId(payout.disbursement.rightsHolderId);
      const group = heldByIdentity.get(key);
      if (group) group.push(payout);
      else heldByIdentity.set(key, [payout]);
    }

    const locks = flows.exceptionQueue.taxLocks;
    expect(locks).toHaveLength(heldByIdentity.size);
    expect(locks).toHaveLength(2);
    const byPayee = new Map(locks.map((row) => [row.identityKey, row]));
    expect(byPayee.get('identity-operations')!.lockReason).toBe('INVALID_OR_MISSING_TIN_BACKUP_WITHHOLDING');
    expect(byPayee.get('identity-vault-runners')!.lockReason).toBe('UNVERIFIED_FOREIGN_PAYEE_MANDATORY_30_PERCENT_LOCK');

    // Engine equality — every row's totals are foldResolutions' own output
    // over the SAME identity-keyed payout group.
    for (const [identityKey, payouts] of heldByIdentity) {
      const engine = foldResolutions(payouts);
      const row = byPayee.get(identityKey);
      expect(row).toBeDefined();
      expect(row!.payeeName).toBe(payouts[0]!.disbursement.rightsHolderName);
      expect(row!.grossCents).toBe(engine.grossCents);
      expect(row!.withheldCents).toBe(engine.withheldCents);
      expect(row!.stateTaxCents).toBe(engine.stateTaxCents);
      expect(row!.netCents).toBe(engine.netCents);
      expect(row!.payoutCount).toBe(payouts.length);
      expect(typeof row!.grossCents).toBe('bigint');
    }
  });

  it('counts the excluded non-USD settlements and keeps the quarantine honest', () => {
    expect(flows.exceptionQueue.excludedNonUsdSettlements).toBe(0);
    expect(flows.exceptionQueue.quarantinedEvents).toEqual([]);
  });
});

describe('Operations · payee/creator registry', () => {
  it('joins every payee exactly through identityKeyFromPayeeId', () => {
    const states = escrowStateFromRows(ledgerRows);
    expect(flows.registry.length).toBeGreaterThan(0);
    for (const row of flows.registry) {
      // The join key is the crosswalk's own derivation — never invented.
      expect(row.identityKey).toBe(identityKeyFromPayeeId(row.payeeId));
      // Money context equals the escrow-state fold for the payee (0n when absent).
      const state = states.find((s) => s.rightsHolderId === row.payeeId);
      expect(row.creditedGrossUnits).toBe(state?.grossUnits ?? 0n);
      expect(row.creditedWithheldUnits).toBe(state?.withheldUnits ?? 0n);
      expect(row.creditedNetUnits).toBe(state?.netUnits ?? 0n);
      // Every money field stays bigint.
      expect(typeof row.creditedGrossUnits).toBe('bigint');
      expect(typeof row.creditedNetUnits).toBe('bigint');
      // No profile store under the local seed — the join honestly yields null.
      expect(row.creatorProfileId).toBeNull();
    }
  });

  it('shows the UCT identity joins of record for the seeded payees', () => {
    const identities = UCT_DEMO_IDENTITIES;
    let resolved = 0;
    for (const row of flows.registry) {
      if (row.uctIdentity === null) continue;
      resolved += 1;
      // The join copies the master table's own record for the key — never
      // a parallel identity invention.
      expect(row.uctIdentity).toEqual(identities[row.identityKey]);
    }
    expect(resolved).toBeGreaterThan(0);
  });

  it('pins the founder payee to its vault of record and five royalty runs', () => {
    const founderRow = flows.registry.find((r) => r.payeeId === 'rh_yeshua_throne_don');
    expect(founderRow).toBeDefined();
    expect(founderRow!.vault).not.toBeNull();
    expect(founderRow!.vault!.reserveCents).toBe(100_000_000_000n);
    expect(founderRow!.runCount).toBe(5);
  });

  it('pins the label payee to every royalty run', () => {
    const labelRow = flows.registry.find((r) => r.payeeId === 'rh_thrones_label_don');
    expect(labelRow).toBeDefined();
    expect(labelRow!.runCount).toBe(119);
    expect(labelRow!.vault!.pendingCents).toBe(427_843_706_668n);
  });
});

describe('Operations · operator audit log', () => {
  it('distinguishes an unpersisted backend from an empty log', async () => {
    // The in-memory store does not keep admin_action_log — the payload says
    // so explicitly instead of rendering a bare [].
    expect(flows.auditLog.persisted).toBe(false);
    expect(flows.auditLog.rows).toEqual([]);
  });
});

describe('Operations · fail-closed behavior', () => {
  it('degrades to the honest null and logs when a store read fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const throwingStore = Object.create(store) as Store;
      throwingStore.listGlJournals = async () => {
        throw new Error('store read failed');
      };
      const result = await operationsFlows({
        store: throwingStore,
        ledgerRows,
        assets,
        taxJoinContext: EMPTY_JOINS,
        creatorProfiles: null,
      });
      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

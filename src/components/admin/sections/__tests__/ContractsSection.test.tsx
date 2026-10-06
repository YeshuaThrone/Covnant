/**
 * ContractsSection — the CONTRACT REGISTRY render test (founder directive,
 * 2026-09-20: the Contracts tab is NOT the money view — it is the registry).
 *
 * Asserted against the LIVE dev-seed store: execution stamps arrive from
 * the real lane POST path (mintExecutionLane through the demo door's seed),
 * template bindings from the master store, vault rows from the vault state
 * machine. Includes the DEDUPE REGRESSION — the two admin sections must
 * never render identical trees again.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';
import { seedAdminDemoDataIfEmpty } from '@/lib/admin/demoSeeds';
import {
  attachContractCvt,
  buildContractRegistrySection,
  buildLedgerFinancesSection,
  type ListAssetsResult,
} from '@/lib/admin/sectionPayloads';
import { resolveMasterLedger, resolveMasterTemplates, demoCvtCode } from '@/lib/master/masterStore';
import { summarizeSovereignLedger } from '@/lib/master/sovereignLedger';
import { listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
import { CVT_PATTERN } from '@/lib/covnant/cvt';
import { listContracts } from '@/lib/contracts/store';
import type { ContractRow } from '@/components/admin/types';
import { ContractsSection } from '../ContractsSection';
import { LedgerSection } from '../LedgerSection';

beforeAll(async () => {
  // The dev-seed boot — the lane execution lands through the REAL POST path.
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
  await seedAdminDemoDataIfEmpty();
});

/** The /admin page's StoredContract → read-only row mapping WITH its stored-CVT join, verbatim shape. */
async function seededContractRows(assets: ListAssetsResult): Promise<ContractRow[]> {
  const contracts = await listContracts();
  const rows: ContractRow[] = contracts.map((contract) => ({
    id: contract.id,
    cbtCode: contract.cbtCode,
    templateId: contract.templateId,
    industry: contract.industry,
    status: contract.status,
    createdAt: new Date(contract.createdAt).toISOString(),
    updatedAt: new Date(contract.updatedAt).toISOString(),
  }));
  const enriched = attachContractCvt({ kind: 'ready', value: rows }, assets);
  if (enriched.kind !== 'ready') throw new Error(`contract CVT join unavailable: ${enriched.code}`);
  return enriched.value;
}

describe('ContractsSection — the contract registry', () => {
  it('renders CBT-stamped execution rows with CBT/CVT lineage from the lane POST path', async () => {
    const { demo, records } = await resolveMasterTemplates();
    const { records: masterRecords } = await resolveMasterLedger();
    const payload = buildContractRegistrySection({ demo, records }, masterRecords);

    expect(payload.executions.length).toBeGreaterThan(0);
    const stamp = payload.executions[0];
    expect(stamp.executionId.startsWith('CBT-EXEC-')).toBe(true);
    // The stamp's lineage is the minted binding's own pair — the CVT is the
    // demo asset's stored-shape handle of record, never an invented pairing.
    const { cbt } = stamp;
    expect(cbt).not.toBeNull();
    if (cbt === null) return; // narrows the nullable lineage type for the checker
    expect(stamp.cvt).toBe(demoCvtCode(cbt));
    expect(stamp.cvt === null || CVT_PATTERN.test(stamp.cvt)).toBe(true);
    expect(stamp.templateId).toMatch(/^TPL-/);

    const markup = renderToStaticMarkup(
      <ContractsSection registry={payload} contracts={{ kind: 'ready', value: [] }} />,
    );
    expect(markup).toContain('contract-execution-registry');
    expect(markup).toContain(stamp.executionId);
    expect(markup).toContain(stamp.cbt ?? '');
    expect(markup).toContain(stamp.cvt ?? '');
  });

  it('renders template bindings with entity telemetry and lane execution state', async () => {
    const { demo, records } = await resolveMasterTemplates();
    const { records: masterRecords } = await resolveMasterLedger();
    const payload = buildContractRegistrySection({ demo, records }, masterRecords);
    expect(payload.templates.length).toBeGreaterThan(0);

    const rows = await seededContractRows(await listAssets());
    expect(rows.length).toBeGreaterThan(0);
    const markup = renderToStaticMarkup(
      <ContractsSection registry={payload} contracts={{ kind: 'ready', value: rows }} />,
    );
    expect(markup).toContain('template-binding-registry');
    expect(markup).toContain('Entity class');
    expect(markup).toContain('Lane state');
    expect(markup).toContain('Signature state: AWAITING SIGNATURE');
    // The vault's CVT column shows the stored handle of record — and when the
    // asset carries one, the engine-shaped value renders verbatim.
    const withCvt = rows.find((row) => row.cvt != null);
    expect(withCvt).toBeDefined();
    expect(markup).toContain(withCvt?.cvt ?? '');
  });

  it('renders NO synthesized CVT for an asset with no stored handle (fail-closed)', async () => {
    const { demo, records } = await resolveMasterTemplates();
    const { records: masterRecords } = await resolveMasterLedger();
    const payload = buildContractRegistrySection({ demo, records }, masterRecords);
    // A vault row whose asset has NO stored CVT — the pre-migration null case.
    // The old synthesis for this CBT would read `CVT-TRK-FF01`; it must never appear.
    const orphan: ContractRow = {
      id: 'contract-orphan-shape',
      cbtCode: 'CBT-TRK-FFFFFFFFFF01',
      cvt: null,
      templateId: 'TPL-MUSIC-MASTER',
      industry: 'Music',
      status: 'FINAL',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const markup = renderToStaticMarkup(
      <ContractsSection registry={payload} contracts={{ kind: 'ready', value: [orphan] }} />,
    );
    expect(markup).toContain(orphan.cbtCode);
    expect(markup).not.toContain('CVT-TRK-FF01');
    // Every well-shaped CVT value in the tree is engine-shaped or absent.
    for (const match of markup.match(/CVT-[A-Z0-9]{6}-\d{4}/g) ?? []) {
      expect(CVT_PATTERN.test(match)).toBe(true);
    }
  });

  it('renders NO settlement math — money lives exclusively on the Ledger tab', async () => {
    const { demo, records } = await resolveMasterTemplates();
    const { records: masterRecords } = await resolveMasterLedger();
    const markup = renderToStaticMarkup(
      <ContractsSection
        registry={buildContractRegistrySection({ demo, records }, masterRecords)}
        contracts={{ kind: 'ready', value: await seededContractRows(await listAssets()) }}
      />,
    );
    // None of the finances surface's tables or money vocabulary may appear.
    expect(markup).not.toContain('corner-dust-settlement-table');
    expect(markup).not.toContain('escrow-state-table');
    expect(markup).not.toContain('Corner dust');
    expect(markup).not.toContain('Gross earned');
    expect(markup).not.toContain('master-stat-cards');
    expect(markup).not.toContain('sovereign-ledger-table');
  });
});

describe('Dedupe regression — the two admin sections render DISTINCT trees', () => {
  it('the Contracts registry never repeats the Ledger finances tree (founder bug, 2026-09-20)', async () => {
    const [ledgerRows, assets] = await Promise.all([listLedger(), listAssets()]);
    const { demo: tDemo, records: tRecords } = await resolveMasterTemplates();
    const { demo: lDemo, records: lRecords } = await resolveMasterLedger();

    const ledgerMarkup = renderToStaticMarkup(
      <LedgerSection
        finances={buildLedgerFinancesSection(ledgerRows, assets)}
        master={{ demo: lDemo, summary: summarizeSovereignLedger(lRecords), records: [...lRecords] }}
      />,
    );
    const contractsMarkup = renderToStaticMarkup(
      <ContractsSection
        registry={buildContractRegistrySection({ demo: tDemo, records: tRecords }, lRecords)}
        contracts={{ kind: 'ready', value: await seededContractRows(assets) }}
      />,
    );

    // Not identical trees...
    expect(ledgerMarkup).not.toEqual(contractsMarkup);
    // ...and the specific duplication is structurally impossible: the master
    // financial tables render ONLY on the Ledger side.
    expect(ledgerMarkup).toContain('master-stat-cards');
    expect(ledgerMarkup).toContain('sovereign-ledger-table');
    expect(contractsMarkup).not.toContain('master-stat-cards');
    expect(contractsMarkup).not.toContain('sovereign-ledger-table');
    // The corner-dust settlement table is the Ledger finances headline.
    expect(ledgerMarkup).toContain('corner-dust-settlement-table');
    expect(contractsMarkup).not.toContain('corner-dust-settlement-table');
  });
});

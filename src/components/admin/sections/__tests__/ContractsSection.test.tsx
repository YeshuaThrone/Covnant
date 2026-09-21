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
  buildContractRegistrySection,
  buildLedgerFinancesSection,
} from '@/lib/admin/sectionPayloads';
import { resolveMasterLedger, resolveMasterTemplates } from '@/lib/master/masterStore';
import { summarizeSovereignLedger } from '@/lib/master/sovereignLedger';
import { listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
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

/** The /admin page's StoredContract → read-only row mapping, verbatim shape. */
async function seededContractRows(): Promise<ContractRow[]> {
  const contracts = await listContracts();
  return contracts.map((contract) => ({
    id: contract.id,
    cbtCode: contract.cbtCode,
    templateId: contract.templateId,
    industry: contract.industry,
    status: contract.status,
    createdAt: new Date(contract.createdAt).toISOString(),
    updatedAt: new Date(contract.updatedAt).toISOString(),
  }));
}

describe('ContractsSection — the contract registry', () => {
  it('renders CBT-stamped execution rows with CBT/CVT lineage from the lane POST path', async () => {
    const { demo, records } = await resolveMasterTemplates();
    const { records: masterRecords } = await resolveMasterLedger();
    const payload = buildContractRegistrySection({ demo, records }, masterRecords);

    expect(payload.executions.length).toBeGreaterThan(0);
    const stamp = payload.executions[0];
    expect(stamp.executionId.startsWith('CBT-EXEC-')).toBe(true);
    expect(stamp.cbt).toBe('CBT-TRK-A51DF05B4279');
    expect(stamp.cvt).toMatch(/^CVT-/);
    expect(stamp.templateId).toBe('TPL-AUD-001');

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

    const rows = await seededContractRows();
    expect(rows.length).toBeGreaterThan(0);
    const markup = renderToStaticMarkup(
      <ContractsSection registry={payload} contracts={{ kind: 'ready', value: rows }} />,
    );
    expect(markup).toContain('template-binding-registry');
    expect(markup).toContain('Entity class');
    expect(markup).toContain('Lane state');
    expect(markup).toContain('Signature state: AWAITING SIGNATURE');
  });

  it('renders NO settlement math — money lives exclusively on the Ledger tab', async () => {
    const { demo, records } = await resolveMasterTemplates();
    const { records: masterRecords } = await resolveMasterLedger();
    const markup = renderToStaticMarkup(
      <ContractsSection
        registry={buildContractRegistrySection({ demo, records }, masterRecords)}
        contracts={{ kind: 'ready', value: await seededContractRows() }}
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
        contracts={{ kind: 'ready', value: await seededContractRows() }}
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

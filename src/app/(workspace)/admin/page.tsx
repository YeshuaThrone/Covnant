/**
 * /admin — the gated operator console.
 *
 * Three honest views, chosen server-side before anything renders
 * (adminPageView over the gate verdict):
 *   - 'unavailable' — ADMIN_DASHBOARD_PASSWORD is unset; the console
 *     cannot be enabled and says so plainly (no form, no lie).
 *   - 'login' — the AdminGate: the only thing an unauthenticated visitor
 *     can see. No hints about what lies behind.
 *   - 'console' — AdminConsole with server-side reads over the verified
 *     stores: registry (provisioning status ONLY), ledger, contracts,
 *     creator profiles, and platform allowlists. Supabase-backed stores
 *     degrade to their honest unavailable state when the service-role
 *     client cannot be built.
 *
 * The gate never touches middleware — this page (and every /api/admin
 * route) verifies the signed session itself, per the PR F contract.
 */

import { cookies } from 'next/headers';
import { listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
import { listContracts, type StoredContract } from '@/lib/contracts/store';
import { listCreators } from '@/lib/admin/creators';
import { listAllowlists } from '@/lib/admin/allowlists';
import { supabaseFromEnv } from '@/lib/supabase';
import type { AdminStoreResult } from '@/lib/admin/types';
import { registrySummary, ledgerSummary } from '@/lib/admin/overview';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/gate';
import { adminPageView } from '@/lib/admin/console';
import { AdminGate } from '@/components/admin/AdminGate';
import { AdminConsole } from '@/components/admin/AdminConsole';
import type { AdminConsoleData, ContractRow, SectionData } from '@/components/admin/types';

export const dynamic = 'force-dynamic';

const NOT_CONFIGURED_NOTICE =
  'The admin console is not configured. Set the ADMIN_DASHBOARD_PASSWORD environment variable to enable operator access.';

/** StoredContract → the console's read-only row (record metadata, never the document). */
function contractRows(contracts: StoredContract[]): ContractRow[] {
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

/** Store result → the section's honest data union (null = no service-role client). */
function toSectionData<T>(result: AdminStoreResult<T> | null): SectionData<T> {
  if (!result) {
    return {
      kind: 'unavailable',
      code: 'supabase_not_configured',
      message: 'Supabase credentials are not configured.',
    };
  }
  return result.ok
    ? { kind: 'ready', value: result.value }
    : { kind: 'unavailable', code: result.code, message: result.message };
}

/**
 * listContracts throws on a store read failure (its documented contract) —
 * one failing store must never take the whole console down, so the read
 * is caught here and degraded to the section's honest unavailable state.
 */
function safeContractsRead(): Promise<AdminStoreResult<ContractRow[]>> {
  return listContracts()
    .then(
      (rows): AdminStoreResult<ContractRow[]> => ({
        ok: true,
        value: contractRows(rows),
      }),
    )
    .catch(
      (): AdminStoreResult<ContractRow[]> => ({
        ok: false,
        status: 502,
        code: 'contract_store_failed',
        message: 'Contract store read failed.',
      }),
    );
}

export default async function AdminPage() {
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value ?? null;
  const view = adminPageView(verifyAdminSession(token));

  if (view === 'unavailable') {
    return <AdminGate notice={NOT_CONFIGURED_NOTICE} />;
  }
  if (view === 'login') {
    return <AdminGate />;
  }

  const db = supabaseFromEnv();
  const [ledgerRows, assets, contracts, creators, allowlists] = await Promise.all([
    listLedger(),
    listAssets(),
    safeContractsRead(),
    db ? listCreators(db) : Promise.resolve(null),
    db ? listAllowlists(db) : Promise.resolve(null),
  ]);

  const data: AdminConsoleData = {
    registry: registrySummary(assets),
    ledger: ledgerSummary(ledgerRows),
    contracts: toSectionData(contracts),
    creators: toSectionData(creators),
    allowlists: toSectionData(allowlists),
  };

  return <AdminConsole data={data} />;
}

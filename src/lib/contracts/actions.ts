'use server';

/**
 * Contract Vault server actions — PR 3.
 *
 * The audit runner wraps the engine's own auditor
 * (CovenantAuditorAgent.RunFullSystemAudit) over the app's SDK singleton so it
 * works in both data modes; the engine's runSystemAuditAction hard-requires
 * Supabase credentials, which v1 does not guarantee. The report shape is the
 * engine's SystemAuditReport, rendered verbatim by the AuditRunner.
 */

import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { CovenantAuditorAgent, type SystemAuditReport } from '@/engine/covenant-master-sdk';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/gate';
import { markContractFinal, saveContract } from '@/lib/contracts/store';
import type { AgreementContext } from '@/lib/contracts/generator';
import type { ContractIndustry } from '@/lib/contracts/templates';
import { requireOperator } from '@/lib/server/apiAccess';
import { getSdk } from '@/lib/sdk';

export interface AuditActionResult {
  success: true;
  report: SystemAuditReport;
}

export interface AuditActionFailure {
  success: false;
  error: string;
}

export async function runVaultAuditAction(): Promise<AuditActionResult | AuditActionFailure> {
  // Gated from day one (admin console PR): this action ran unauthenticated
  // until now. Every invocation must carry a valid admin session cookie —
  // unset secret → admin_not_configured (fail closed), absent/expired/
  // forged cookie → admin_not_authenticated. The failure rides the same
  // shape the audit runner already renders.
  const cookieStore = await cookies();
  const verdict = verifyAdminSession(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
  if (!verdict.ok) {
    return { success: false, error: verdict.code };
  }
  try {
    const auditor = new CovenantAuditorAgent(getSdk());
    const report = await auditor.RunFullSystemAudit();
    return { success: true, report };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

export interface SaveContractInput {
  cbtCode: string;
  templateId: string;
  industry: ContractIndustry;
  context: AgreementContext;
  id?: string;
}

export async function saveContractAction(input: SaveContractInput): Promise<
  { success: true; id: string; status: 'DRAFT' | 'FINAL' } | { success: false; error: string }
> {
  // Gated (audit F2): contract writes ran unauthenticated until now — anyone
  // could write arbitrary drafts and finalize any contract, including another
  // party's. The operator session the sibling audit action demands is verified
  // here as the FIRST statement, from the action's own request headers, before
  // any input handling or store access: unset secret → admin_not_configured
  // (fail closed), absent/expired/forged cookie → admin_not_authenticated.
  // The failure rides this action's existing { success: false, error } shape
  // the ContractEditor already renders.
  const headerList = await headers();
  const verdict = requireOperator({ headers: headerList });
  if (!verdict.ok) {
    return { success: false, error: verdict.code };
  }
  try {
    const saved = await saveContract(input);
    revalidatePath('/contracts');
    revalidatePath(`/contracts/${saved.id}`);
    return { success: true, id: saved.id, status: saved.status };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

export async function markContractFinalAction(
  id: string,
): Promise<{ success: true; status: 'DRAFT' | 'FINAL' } | { success: false; error: string }> {
  // Gated (audit F2) — same operator-session gate as saveContractAction,
  // first statement, before any store access. A finalize is the more
  // dangerous write (an immutable, exportable record), so the refusal
  // never even reads the contract.
  const headerList = await headers();
  const verdict = requireOperator({ headers: headerList });
  if (!verdict.ok) {
    return { success: false, error: verdict.code };
  }
  try {
    const updated = await markContractFinal(id);
    if (!updated) return { success: false, error: 'Contract not found.' };
    revalidatePath('/contracts');
    revalidatePath(`/contracts/${id}`);
    return { success: true, status: updated.status };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

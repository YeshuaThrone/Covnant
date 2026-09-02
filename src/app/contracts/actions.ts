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
import { CovenantAuditorAgent, type SystemAuditReport } from '@/engine/covenant-master-sdk';
import { markContractFinal, saveContract } from '@/lib/contracts/store';
import type { AgreementContext } from '@/lib/contracts/generator';
import type { ContractIndustry } from '@/lib/contracts/templates';
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

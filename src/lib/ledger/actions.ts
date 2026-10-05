'use server';

/**
 * Ledger server actions — PR 4.
 *
 * The direct settlement path runs through the app's SDK singleton (0% direct-path
 * platform fee — the social path's 10% lives in the claims webhook). The engine
 * settles and reconciles; this layer persists the result into the ledger store so
 * /ledger and /rights-holders render it.
 */

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import type { RoyaltySettlementEvent, SettlementResult, SettlementCurrency } from '@/engine/covenant-master-sdk';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/gate';
import { rememberSettlement } from '@/lib/ledger/store';
import { getSdk } from '@/lib/sdk';

export interface SettleDirectInput {
  cbtCode: string;
  grossAmount: number;
  currency: SettlementCurrency | string;
  territoryCountryCode: string;
  sourcePlatform?: string;
  transactionId?: string;
}

export type SettleDirectResult =
  | { success: true; result: SettlementResult }
  | { success: false; error: string };

export async function settleDirectAction(input: SettleDirectInput): Promise<SettleDirectResult> {
  // Gated to match runVaultAuditAction: this action posts settlements to the
  // ledger, so every invocation must carry a valid admin session cookie —
  // unset secret → admin_not_configured (fail closed), absent/expired/forged
  // cookie → admin_not_authenticated. The failure rides the same
  // { success: false, error } shape the settlement form already renders.
  const cookieStore = await cookies();
  const verdict = verifyAdminSession(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
  if (!verdict.ok) {
    return { success: false, error: verdict.code };
  }
  try {
    const cbtCode = input.cbtCode.trim().toUpperCase();
    if (!cbtCode) throw new Error('An asset is required.');
    if (!Number.isFinite(input.grossAmount) || input.grossAmount <= 0) {
      throw new Error('Gross amount must be a positive number.');
    }
    if (typeof input.grossAmount === 'number' && input.grossAmount > 0) {
      // Guard against float artifacts before they enter the BigInt path.
      const decimals = (String(input.grossAmount).split('.')[1] ?? '').length;
      const maxDecimals = input.currency === 'SAT' || input.currency === 'ETH' || input.currency === 'SOL' ? 8 : 4;
      if (decimals > maxDecimals) {
        throw new Error(
          `${input.currency} settles at ${maxDecimals} decimal places; round the gross amount before settling.`
        );
      }
    }

    const event: RoyaltySettlementEvent = {
      transactionId:
        input.transactionId?.trim() || `DIR-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      cbtCode,
      grossAmount: input.grossAmount,
      currency: input.currency as SettlementCurrency,
      sourcePlatform: input.sourcePlatform?.trim() || 'DIRECT',
      territoryCountryCode: input.territoryCountryCode.trim().toUpperCase() || 'US',
      timestamp: Date.now(),
    };

    const sdk = getSdk();
    const result = await sdk.processRoyaltySettlement(event);
    if (result.reconciliationStatus !== 'PASS') {
      throw new Error(`Settlement failed reconciliation (${result.reconciliationStatus}); nothing was recorded.`);
    }

    await rememberSettlement(result, event.sourcePlatform);
    revalidatePath('/ledger');
    revalidatePath('/rights-holders');
    return { success: true, result };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

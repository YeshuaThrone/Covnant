/**
 * The contract viewer (audit F6/F7, spec D7) — which principal's eyes a
 * contract read runs for. The workspace pages resolve this server-side as
 * their FIRST statement, before any store access:
 *
 *   - demo door open (dev seed mode AND no Supabase) → operator — the
 *     sessionless seeded preview renders exactly as it always has (the
 *     export route's own demo-door posture);
 *   - the signed operator cookie → operator — the console sees every row;
 *   - a registered creator session → creator, scoped to the session-bound
 *     payee id resolveSessionCreator derives from the VERIFIED session
 *     (never a client-supplied id);
 *   - anything else (anonymous, unenrolled) → null — no rows.
 *
 * A resolver READ FAILURE throws (SessionCreatorReadError) — fail closed
 * and honest: a server error is never surfaced as an empty state.
 */

import { headers } from 'next/headers';
import { checkAdminGate } from '@/lib/admin/gate';
import { isDemoDoorOpen } from '@/lib/admin/demoSeeds';
import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import type { ContractViewer } from './store';

export async function resolveContractViewer(): Promise<ContractViewer | null> {
  if (isDemoDoorOpen()) return { role: 'operator' };
  const headerList = await headers();
  if (checkAdminGate({ headers: headerList }).ok) return { role: 'operator' };
  const session = await resolveSessionCreator();
  if (session.kind === 'registered') {
    return { role: 'creator', creatorId: session.creator.payee_id };
  }
  return null;
}

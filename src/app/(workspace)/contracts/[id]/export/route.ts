/**
 * GET /contracts/[id]/export — the Contract Vault's text export
 * (spec §Contract vault: "Save stores a draft in contracts → mark final →
 * export"; the editor's Export button is a plain href here).
 *
 * GATED, fail-closed: the stored document is rendered agreement text —
 * it is served only to a verified principal. Contracts are workspace/
 * creator data (the vault is the creator's own flow, not the operator
 * console), so the principal pair is holder-or-operator:
 *
 *   - holder   — a registered creator session through resolveSessionCreator
 *                (the verified-session posture every holder-scoped route
 *                shares: anonymous 401 no_session, unenrolled 403
 *                not_registered, resolver read failure 502);
 *   - operator — the signed admin cookie through checkAdminGate (the tax
 *                export's own gate: 503 admin_not_configured when the
 *                secret is unset, 401 admin_not_authenticated).
 *
 * THE DEMO DOOR — isDemoDoorOpen() (dev seed mode AND no Supabase
 * configured) keeps the sessionless seeded preview working exactly as the
 * console's demo door does: the export runs sessionless against the seeded
 * contracts. With Supabase configured the door is closed and every request
 * needs a principal; an anonymous one answers 401 with the sibling error
 * envelope and never learns whether an id exists (the gate precedes the
 * store read).
 *
 * StoredContract carries no holder column, so per-row holder matching is
 * not enforceable on this store yet — the gate demands a verified
 * principal rather than pretending row-level scoping it cannot check.
 */

import { getContract } from '@/lib/contracts/store';
import { isDemoDoorOpen, seedAdminDemoDataIfEmpty } from '@/lib/admin/demoSeeds';
import { checkAdminGate } from '@/lib/admin/gate';
import { donJsonError } from '@/lib/server/http';
import {
  resolveSessionCreator,
  SessionCreatorReadError,
} from '@/lib/server/sessionCreator';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  if (!isDemoDoorOpen()) {
    let session: Awaited<ReturnType<typeof resolveSessionCreator>>;
    try {
      session = await resolveSessionCreator();
    } catch (error) {
      if (error instanceof SessionCreatorReadError) {
        return donJsonError(502, error.code, error.message);
      }
      throw error;
    }

    // Holder principal — the registered creator session. An anonymous or
    // unenrolled session may still carry the operator cookie.
    if (session.kind !== 'registered' && !checkAdminGate(request).ok) {
      return session.kind === 'anonymous'
        ? donJsonError(401, 'no_session', 'Sign in to export a contract.')
        : donJsonError(
            403,
            'not_registered',
            'This session is not enrolled as a rights holder.',
          );
    }
  }

  // The demo door — the same idempotent seed the console and the tax sheet
  // run, so the sessionless preview exports the seeded agreements (a no-op
  // whenever the door is closed).
  await seedAdminDemoDataIfEmpty();

  const contract = await getContract(id);
  if (!contract) return new Response('Contract not found.', { status: 404 });

  return new Response(contract.document, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${contract.id}-${contract.templateId}.txt"`,
      'Cache-Control': 'no-store',
    },
  });
}

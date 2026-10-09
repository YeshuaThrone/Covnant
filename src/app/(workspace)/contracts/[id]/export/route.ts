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
 * TENANT SCOPING (audit F7, remediation spec D7) — the store now carries
 * per-row ownership: contracts.creator_id (migration 0062) is stamped from
 * the creating session's registered-creator identity. After the principal
 * gate, the export reads under that principal's viewer:
 *
 *   - a registered creator exports only the contracts their own session
 *     created — a foreign id or a NULL-creator (legacy/unattributed) row
 *     is answered 404;
 *   - operators/admins export any row, NULL-creator rows included.
 *
 * Unknown AND foreign ids answer the same 404 — never 403 — per the
 * workspace's cross-tenant rule: a miss is indistinguishable from a
 * nonexistent id. (This replaces the v1 posture that served any stored
 * contract to any verified principal.)
 */

import { getContract, type ContractViewer } from '@/lib/contracts/store';
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

  let viewer: ContractViewer;
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
    const operator = checkAdminGate(request).ok;
    if (operator) {
      // The operator cookie outranks the creator session — the console
      // sees every row.
      viewer = { role: 'operator' };
    } else if (session.kind === 'registered') {
      // The export is scoped to the session's own contracts (spec D7).
      viewer = { role: 'creator', creatorId: session.creator.payee_id };
    } else {
      return session.kind === 'anonymous'
        ? donJsonError(401, 'no_session', 'Sign in to export a contract.')
        : donJsonError(
            403,
            'not_registered',
            'This session is not enrolled as a rights holder.',
          );
    }
  } else {
    viewer = { role: 'operator' };
  }

  // The demo door — the same idempotent seed the console and the tax sheet
  // run, so the sessionless preview exports the seeded agreements (a no-op
  // whenever the door is closed).
  await seedAdminDemoDataIfEmpty();

  const contract = await getContract(id, viewer);
  if (!contract) return new Response('Contract not found.', { status: 404 });

  return new Response(contract.document, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${contract.id}-${contract.templateId}.txt"`,
      'Cache-Control': 'no-store',
    },
  });
}

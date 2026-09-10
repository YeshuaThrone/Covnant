/**
 * identityFromMe — pure mappers from the verified session aggregate
 * (CovnantMeResponse) to the identity display unions. ONE translation
 * point so the sidebar badge, the dashboard card, and any future surface
 * interpret the aggregate identically; the unions keep their own render
 * guards (resolveRenderedState / resolveRenderedCardState).
 *
 * No string here is ever synthesized: values pass through from the
 * aggregate or the field is omitted.
 */

import type { CreatorIdCardState } from '@/components/brand/CreatorIdCard';
import type { IdentityState } from '@/components/brand/IdentityBadge';
import type { CovnantMeResponse } from '@/lib/covnant/types';

/** The sidebar pill's state — UCT + issuance facts, status text only. */
export function identityBadgeStateFromMe(me: CovnantMeResponse): IdentityState {
  return {
    kind: 'anchored',
    uct: me.identity.uct,
    status: me.provisioning.status,
    uctCreatedAt: me.identity.uctCreatedAt,
    jurisdiction: me.identity.jurisdiction,
  };
}

/** The dashboard centerpiece's state — adds the stage name and role. */
export function creatorIdCardStateFromMe(me: CovnantMeResponse): CreatorIdCardState {
  return {
    kind: 'anchored',
    stageName: me.profile.stage_name,
    uct: me.identity.uct,
    status: me.provisioning.status,
    uctCreatedAt: me.identity.uctCreatedAt,
    jurisdiction: me.identity.jurisdiction,
    role: me.role,
  };
}

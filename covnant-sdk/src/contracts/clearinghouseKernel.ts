/**
 * COVNANT CLEARINGHOUSE KERNEL — the converged data model (spec art_ZIdWlYUX).
 *
 * One `participants[]` array, three integer-BPS pools per participant, the
 * creator identity card payload, and exact-equality validation with typed
 * errors. Contracts stay store-agnostic — the store read is injected (the
 * PR 4 vault adapter pattern).
 *
 * Boundary rule (the kernel's one law): `validateLedgerBps` is payload-layer
 * pre-validation for split sheets and ledger submissions. It NEVER allocates
 * money. Actual cent allocation runs exclusively through `calculateUdrSplits`
 * via the settlement wire, which owns dust, withholding, and CBT stamping.
 *
 * The kernel never mints. It reads the UCT minted at signup through the
 * injected reader; a missing UCT is a typed error, never a silent new
 * identity. No Foundation labels, no hardcoded admin entities, no platform
 * UCTs, no default platform-side capture — creators retain 100% of their
 * copyright shares by default.
 */

import { canonicalizeIdentifier } from './identifiers';

export const TOTAL_BASIS_POINTS = 10_000;

export type ParticipantRole =
  | 'primary_artist' | 'featured_artist' | 'songwriter' | 'producer' | 'publisher';

export interface BasisPointParticipant {
  uctNumber: string;   // UCT-<CC>-<YYYY>-<8 hex>-<2 check>
  role: ParticipantRole;
  masterBps: number;   // integers only — each pool sums to exactly 10_000
  writerBps: number;
  publisherBps: number;
}

export interface UniversalAssetLedgerSpec {
  cvtAssetTag: string;          // CVT asset vault tag from the registration flow
  primaryUct: string;           // UCT of the primary uploader — read, never minted
  participants: BasisPointParticipant[];
  cbtSettlementStamp?: string;  // authored by the settlement wire only — never by callers
}

export interface CreatorIdentityCardPayload {
  uctNumber: string;            // reused from sign-up — the kernel never mints
  isni: string | null;          // canonicalized; null when absent or malformed
  cardStatus: 'ACTIVE_EARNING';
  kycPendingAtPayout: boolean;  // payout gate routes through withholding
}

export class KernelValidationError extends Error {
  constructor(
    readonly pool: 'master' | 'writer' | 'publisher',
    readonly actualBps: number,
  ) {
    super(`${pool} pool sums to ${actualBps} BPS; must equal exactly ${TOTAL_BASIS_POINTS}`);
  }
}

export class KernelBpsIntegrityError extends Error {
  constructor() { super('BPS values must be integers'); }
}

export class CreatorIdentityError extends Error {
  constructor(readonly creatorId: string) {
    super(`Identity Error: no root UCT for creatorId ${creatorId}. UCT must be minted at sign-up.`);
  }
}

const POOLS = ['master', 'writer', 'publisher'] as const;
type Pool = (typeof POOLS)[number];

/** Payload-layer pre-validation ONLY — never allocates money. */
export function validateLedgerBps(asset: UniversalAssetLedgerSpec): void {
  if (asset.participants.length === 0) throw new KernelValidationError('master', 0);
  // Fractional BPS is rejected before summing: fractions that happen to
  // total 10,000 must not slip past an integer-only invariant.
  for (const p of asset.participants) {
    for (const bps of [p.masterBps, p.writerBps, p.publisherBps]) {
      if (!Number.isInteger(bps)) throw new KernelBpsIntegrityError();
    }
  }
  const poolSums: Record<Pool, number> = {
    master: asset.participants.reduce((s, p) => s + p.masterBps, 0),
    writer: asset.participants.reduce((s, p) => s + p.writerBps, 0),
    publisher: asset.participants.reduce((s, p) => s + p.publisherBps, 0),
  };
  for (const pool of POOLS) {
    if (poolSums[pool] !== TOTAL_BASIS_POINTS) throw new KernelValidationError(pool, poolSums[pool]);
  }
}

type CreatorUctReader = (creatorId: string) =>
  Promise<{ uctNumber: string; isni: string | null } | null>;

export async function resolveCreatorCard(
  readCreatorUct: CreatorUctReader, // injected — contracts stay store-agnostic
  creatorId: string,
): Promise<CreatorIdentityCardPayload> {
  const record = await readCreatorUct(creatorId);
  if (!record) throw new CreatorIdentityError(creatorId);
  return {
    uctNumber: record.uctNumber,
    isni: record.isni ? canonicalizeIdentifier('ISNI', record.isni) : null,
    cardStatus: 'ACTIVE_EARNING',
    kycPendingAtPayout: true,
  };
}

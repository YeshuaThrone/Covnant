/**
 * Contract presentation layer — directive §4.
 *
 * Pure, client-safe mapping over the persisted contract state. The store's
 * DRAFT/FINAL schema is untouched: Draft / Pending / Completed is a UI
 * mapping (FINAL → Completed; DRAFT with a signature requested → Pending),
 * and signature progress lives client-side per agreement — no new server
 * state, no schema change.
 */

import type { AgreementContext, AgreementParty } from './generator';

// ── Status presentation ────────────────────────────────────────────────────

export type PresentationStatus = 'Draft' | 'Pending' | 'Completed';

export function presentationStatus(
  status: 'DRAFT' | 'FINAL',
  signatureRequested: boolean,
): PresentationStatus {
  if (status === 'FINAL') return 'Completed';
  return signatureRequested ? 'Pending' : 'Draft';
}

/**
 * Tailwind chip classes per presentation status — design-system tones:
 * champagne for in-progress, amber for pending, emerald for completed.
 */
export const STATUS_CHIP_CLASSES: Record<PresentationStatus, string> = {
  Draft: 'border-white/25 text-white/70',
  Pending: 'border-amber-400/40 text-amber-300',
  Completed: 'border-emerald-400/40 text-emerald-300',
};

// ── Digital signature tracking (client-side) ───────────────────────────────

export type SignatureState = 'NOT_REQUESTED' | 'REQUESTED' | 'SIGNED';

export const SIGNATURE_LABELS: Record<SignatureState, string> = {
  NOT_REQUESTED: 'Not requested',
  REQUESTED: 'Requested',
  SIGNED: 'Signed',
};

/** Chip classes per signature state, matching the status tones. */
export const SIGNATURE_CHIP_CLASSES: Record<SignatureState, string> = {
  NOT_REQUESTED: 'border-white/25 text-white/50',
  REQUESTED: 'border-amber-400/40 text-amber-300',
  SIGNED: 'border-emerald-400/40 text-emerald-300',
};

/**
 * One signature row per agreement party, in the agreement's own party order.
 * The map is keyed by `name::role` — the same stable key the generator uses
 * to dedupe parties.
 */
export function signatureRows(parties: AgreementParty[]): { key: string; name: string; role: string }[] {
  return parties.map((p) => ({
    key: `${p.name}::${p.role}`,
    name: p.name,
    role: p.role,
  }));
}

/** Storage key for an agreement's client-side signature state. */
export function signatureStorageKey(contractId: string | undefined, cbtCode: string, templateId: string): string {
  return contractId
    ? `covnant-signatures:${contractId}`
    : `covnant-signatures:draft:${cbtCode}:${templateId}`;
}

// ── Deterministic auto-fill summary ────────────────────────────────────────

export interface AutoFilledField {
  label: string;
  value: string;
  /**
   * True when the holder profile / asset registry lacked the datum. The UI
   * renders these as "To be completed" — never a fabricated value.
   */
  toBeCompleted: boolean;
}

export interface AutoFillParty {
  name: string;
  role: string;
  /** Exact recorded share when unambiguous; undefined for merged multi-pool parties. */
  sharePercent?: string;
  /** ISNI / IPI from the holder profile — to-be-completed when absent. */
  identifiers: AutoFilledField[];
}

export interface AutoFillPool {
  label: string;
  totalPercent: string;
  holders: { name: string; sharePercent: string }[];
}

export interface AutoFillSummary {
  work: { title: string; mediumLabel: string; cbtCode: string; displayCode: string };
  /** CBT/CVT plus every registered identifier (ISRC, ISWC, EIDR, …). */
  identifiers: AutoFilledField[];
  parties: AutoFillParty[];
  pools: AutoFillPool[];
}

const TO_BE_COMPLETED = 'To be completed';

/**
 * Builds the deterministic auto-fill view of an agreement context. Reads ONLY
 * what the stored asset of record actually carries: names, roles, splits, and
 * registry identifiers are echoed verbatim; missing profile data renders as
 * to-be-completed. Pure — the same asset yields the same summary every time.
 */
export function autoFillSummary(ctx: AgreementContext): AutoFillSummary {
  const { asset, pools, parties } = ctx;

  const identifiers: AutoFilledField[] = [
    { label: 'CBT', value: asset.cbtCode, toBeCompleted: false },
    { label: 'CVT', value: asset.displayCode, toBeCompleted: false },
    ...asset.identifiers.map((i): AutoFilledField => ({ label: i.label, value: i.value, toBeCompleted: false })),
  ];

  return {
    work: {
      title: asset.title,
      mediumLabel: asset.mediumLabel,
      cbtCode: asset.cbtCode,
      displayCode: asset.displayCode,
    },
    identifiers,
    parties: parties.map((p) => ({
      name: p.name,
      role: p.role,
      sharePercent: p.sharePercent,
      identifiers: [
        p.isni
          ? { label: 'ISNI', value: p.isni, toBeCompleted: false }
          : { label: 'ISNI', value: TO_BE_COMPLETED, toBeCompleted: true },
        p.ipi
          ? { label: 'IPI (PRO)', value: p.ipi, toBeCompleted: false }
          : { label: 'IPI (PRO)', value: TO_BE_COMPLETED, toBeCompleted: true },
      ],
    })),
    pools: pools.map((pool) => ({
      label: pool.label,
      totalPercent: pool.totalPercent,
      holders: pool.holders.map((h) => ({ name: h.name, sharePercent: h.sharePercent ?? '' })),
    })),
  };
}

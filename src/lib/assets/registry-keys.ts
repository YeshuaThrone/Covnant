/**
 * Universal registry pill resolver — the adapter layer's identifier system.
 *
 * The vendored engine stores whatever `UniversalAssetIdentifier` it is handed
 * (`mappedIdentifiers`) and mints the canonical `CBT-<TYPE>-<HASH>` code; it
 * never resolves sector registries itself. The zero-friction MUL flow removes
 * manual identifier entry, so this adapter derives deterministic internal
 * audit keys for the sector identifiers the engine does not supply — and it
 * never presents a fabricated real-world registry code (ISRC / ISWC / EIDR /
 * ISBN) as if it were externally registered: everything derived is a clearly
 * internal `CVT-<PREFIX>-XXXX` audit key.
 *
 * Pure and isomorphic: imported by server components (asset detail, ledger)
 * and client adapters alike, with no engine runtime import.
 */
import type { MediaMedium, UniversalAssetIdentifier } from '@/engine/covenant-master-sdk';
import { cvtDisplayCode } from '@/lib/splits/codes';

export interface RegistryPill {
  key: string;
  label: string;
  value: string;
  /**
   * 'engine'  — stored in the asset's mappedIdentifiers (system of record).
   * 'derived' — deterministic internal audit key minted client-side.
   */
  source: 'engine' | 'derived';
}

export interface RegistryKeyAsset {
  cbtCode: string;
  medium: MediaMedium;
  mappedIdentifiers?: UniversalAssetIdentifier;
}

/** One sector registry slot: the engine field it shadows, its pill label, and its CVT prefix. */
export interface SectorSlot {
  field: keyof UniversalAssetIdentifier;
  label: string;
  prefix: string;
}

/** Music & Audio (directive §2): ISRC for the recording, ISWC for the composition. */
const MUSIC_AUDIO_MEDIUMS: readonly MediaMedium[] = [
  'MUSIC_TRACK',
  'MUSIC_ALBUM',
  'SHEET_MUSIC',
  'PODCAST_EPISODE',
  'AUDIOBOOK',
];

/** Film / TV / Video (directive §2): EIDR root standard for audiovisual works. */
const FILM_TV_VIDEO_MEDIUMS: readonly MediaMedium[] = [
  'FEATURE_FILM',
  'TV_SHOW',
  'TV_SEASON',
  'TV_EPISODE',
  'LIVE_STREAM',
  'MARS_ORBITAL_BROADCAST',
];

const MUSIC_SLOTS: readonly SectorSlot[] = [
  { field: 'isrc', label: 'ISRC (Recording)', prefix: 'ISRC' },
  { field: 'iswc', label: 'ISWC (Composition)', prefix: 'ISWC' },
];

const AV_SLOTS: readonly SectorSlot[] = [
  { field: 'eidrCanonical', label: 'EIDR (10.5240 Root Standard)', prefix: 'EIDR' },
];

/** Sector registry slots that apply to a medium — empty for print/other media. */
export function sectorSlotsForMedium(medium: MediaMedium): readonly SectorSlot[] {
  if (MUSIC_AUDIO_MEDIUMS.includes(medium)) return MUSIC_SLOTS;
  if (FILM_TV_VIDEO_MEDIUMS.includes(medium)) return AV_SLOTS;
  return [];
}

/**
 * FNV-1a (32-bit) — dependency-free and synchronous, so the same seed hashes
 * identically on the server and in the browser bundle. Deterministic per
 * (asset, slot): re-deriving a key tomorrow yields the same audit key.
 */
export function auditKeyHash(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, '0').slice(-4);
}

/** Deterministic `CVT-<PREFIX>-XXXX` internal audit key per asset + sector slot. */
export function sectorAuditKey(cbtCode: string, slot: SectorSlot): string {
  return `CVT-${slot.prefix}-${auditKeyHash(`${cbtCode}::${slot.prefix}`)}`;
}

function mappedIdentifierLabel(field: string): string {
  return field.replaceAll('_', ' ').toUpperCase();
}

/** CBT canonical code + CVT display code — derivable from the code alone. */
export function registryPillsForCode(cbtCode: string): RegistryPill[] {
  return [
    { key: 'cbt', label: 'CBT', value: cbtCode, source: 'engine' },
    { key: 'cvt', label: 'CVT', value: cvtDisplayCode(cbtCode), source: 'derived' },
  ];
}

/**
 * Resolve the universal tracking pills for a registered asset: the engine's
 * canonical code and stored identifiers first, then deterministic internal
 * audit keys for every sector slot the engine does not already supply.
 */
export function resolveRegistryPills(asset: RegistryKeyAsset): RegistryPill[] {
  const pills = registryPillsForCode(asset.cbtCode);

  const mapped = asset.mappedIdentifiers ?? {};
  for (const [field, value] of Object.entries(mapped)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      pills.push({
        key: `mapped-${field}`,
        label: mappedIdentifierLabel(field),
        value: value.trim(),
        source: 'engine',
      });
    }
  }

  for (const slot of sectorSlotsForMedium(asset.medium)) {
    const supplied = (mapped as Record<string, unknown>)[slot.field];
    if (typeof supplied === 'string' && supplied.trim().length > 0) continue;
    pills.push({
      key: `derived-${slot.field}`,
      label: slot.label,
      value: sectorAuditKey(asset.cbtCode, slot),
      source: 'derived',
    });
  }

  return pills;
}

/**
 * Black Box Shield — attach registry pills to a ledger-bound adapter payload
 * (ledger rows, settlement receipts) so payout/ledger views always display
 * the identifiers next to the amounts. Falls back to the code-derived pills
 * when the asset itself is not at hand.
 */
export function withRegistryPills<P extends { cbtCode: string }>(
  payload: P,
  asset?: RegistryKeyAsset,
): P & { registry: RegistryPill[] } {
  return {
    ...payload,
    registry: asset
      ? resolveRegistryPills(asset)
      : registryPillsForCode(payload.cbtCode),
  };
}

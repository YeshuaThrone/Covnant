/**
 * Declaration stub for the vendored engine — scoped to the SDK's strict
 * typecheck program (`tsc -p covnant-sdk`, noUncheckedIndexedAccess).
 *
 * Why this exists: `src/lib/splits/shared.ts` type-imports MediaMedium from
 * the vendored engine. Type-only imports are erased at bundle time (the
 * browser never bundles the vendored SDK — shared.ts's own header), but they
 * still enter a tsc program, and the vendored file is hash-pinned by
 * src/engine/__tests__/vendored-sdk.test.ts — its bytes cannot be touched to
 * satisfy the SDK's stricter indexed-access checks. This paths-redirected
 * declaration keeps the vendored bytes blessed while the SDK program still
 * compile-checks shared.ts against the engine's union, mirrored verbatim from
 * src/engine/covenant-master-sdk.ts (blessed source of truth). The ROOT
 * typecheck resolves the real file, so a drift between the two is caught by
 * CI — keep this mirror in sync when the vendored union changes.
 */
export type MediaMedium =
  | 'MUSIC_TRACK' | 'MUSIC_ALBUM' | 'SHEET_MUSIC'
  | 'FEATURE_FILM' | 'TV_SHOW' | 'TV_SEASON' | 'TV_EPISODE'
  | 'PODCAST_EPISODE' | 'AUDIOBOOK' | 'PRINT_BOOK' | 'EBOOK'
  | 'MAGAZINE_SERIAL' | 'VIDEO_GAME' | 'LIVE_STREAM' | 'MARS_ORBITAL_BROADCAST';

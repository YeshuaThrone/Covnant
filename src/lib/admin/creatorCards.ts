/**
 * creatorCards — the Creators View's data adapter (founder-directed v2.7.2).
 *
 * Two honest sources, never blended:
 *
 * 1. Real rows: listCreators() answers from creator_profiles. The mapper
 *    carries ONLY the columns the row actually holds — UCT, jurisdiction,
 *    engine, and issuance state resolve from the CBT-SIGNUP-REGISTRY (the
 *    Signup API Contract's issuance envelope), and the registry join is NOT
 *    wired yet, so those fields arrive null and the card renders its honest
 *    missing states. Never a fabricated tag.
 *
 * 2. Demo door: when the disclosed demo preview runs (DON_DEV_SEED=1, no
 *    service-role client), creator_profiles has no in-memory shadow (the
 *    store module's fail-closed decision), so the Creators tab would render
 *    its unavailable placeholder — the exact state the founder's Creators
 *    View replaces. The demo set below renders ONLY behind the section's
 *    DemoBadge disclosure, and every demo UCT is derived by the REAL
 *    buildUct checksum from deterministic serials — the same derivation
 *    production signups run, never an invented tag string.
 */

import { buildUct } from '@/lib/covnant/uct';
import type { CreatorCardData } from '@/components/admin/creators/CovnantCreatorsView';
import type { AdminCreatorProfile } from './types';

/** Map a real profile row — signup columns only; registry fields stay null. */
export function mapProfileToCard(profile: AdminCreatorProfile): CreatorCardData {
  return {
    legal_name: profile.legal_name,
    stage_name: profile.stage_name,
    email: profile.email,
    phone: profile.phone,
    core_industry: profile.core_industry,
    title: profile.title,
    // Registry-resolved facts — the join is a named follow-up, so null
    // (the card renders "Not attributed" / "Not yet on file") beats a lie.
    jurisdiction: null,
    engine: null,
    status: null,
    uct: null,
    uctCreatedAt: null,
  };
}

/**
 * The disclosed demo set — the founder-iterated v2.7.2 card presentation.
 * UCTs: real buildUct derivation over fixed serials (deterministic, stable
 * across rebuilds). The banned Nova Reign placeholder is not used (seed canon).
 */
export const DEMO_CREATOR_CARDS: CreatorCardData[] = [
  {
    legal_name: 'Alicia Fontaine',
    stage_name: 'FONTAINE MUSIC',
    email: 'alicia.fontaine@example.com',
    phone: '+1 (312) 555-0148',
    core_industry: 'Music — Recording Artist',
    title: 'Independent Artist',
    jurisdiction: 'US',
    engine: 'music_recording',
    status: 'PROVISIONED',
    uct: buildUct('US', 2026, '9A3F02B7'),
    uctCreatedAt: '2026-09-09',
  },
  {
    legal_name: 'Marcus Vale',
    stage_name: 'VALE SOUNDS',
    email: 'marcus.vale@example.com',
    phone: null,
    core_industry: 'Music — Producer',
    title: 'Producer / Engineer',
    jurisdiction: 'US',
    engine: 'music_recording',
    status: 'PENDING',
    uct: buildUct('US', 2026, '4C71E0A2'),
    uctCreatedAt: '2026-09-21',
  },
  {
    legal_name: 'Imogen Clarke',
    stage_name: 'IMOGEN CLARKE',
    email: 'imogen.clarke@example.com',
    phone: '+44 20 7946 0231',
    core_industry: 'Publishing — Songwriter',
    title: 'Composer / Lyricist',
    jurisdiction: 'UK',
    engine: 'publishing',
    status: 'PROVISIONED',
    uct: buildUct('UK', 2026, '7B2D9F41'),
    uctCreatedAt: '2026-09-18',
  },
];

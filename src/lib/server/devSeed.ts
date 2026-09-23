/**
 * devSeed — the DON_DEV_SEED demo door (SESSIONLESS visitor, production
 * included): a seeded InMemoryStore whose financial state is produced
 * EXCLUSIVELY through the real settlement engine — every rendered dollar
 * comes from a store read; nothing here is a display string.
 *
 * INTELLIGENCE WIDENING (2026-09-23): beyond the founder's story, the seed
 * clears per-entity journal histories for EVERY registered atomic entity —
 * at least two staggered label-only settlements each, so the Entity
 * Intelligence tab's trends read as real series and the multi-entity class
 * families (film, live, publishing) rank against real cohort totals. One
 * DELIBERATE tie: TPL-LIT-003 and TPL-LIT-004 clear the same exact total
 * from different point values, so the standard-competition rank-sharing is
 * visible in the UI. Every added run clears 100% to the demo rights group —
 * the founder persona's pinned vault targets are untouched — and every
 * value is demo-disclosed through the DEMO DATA badge.
 *
 * ANALYTICS DENSIFICATION (2026-09-23): the company analytics page needs a
 * daily CURVE, not dots — the widening above left ~10 active days in the
 * ledger. A second table of label-only runs puts 2-3 further settlements on
 * every empty day between the story runs, so the ledger covers 2026-08-20
 * through 2026-09-23 with no zero-journal day and 2-4 points on most days
 * of the trailing 30. Same real engine path, same label-only allocation
 * (founder targets, escrows, payouts untouched), same demo disclosure; the
 * publishing cohort — and its deliberate 92,000,000-cent tie — is
 * deliberately NOT densified.
 *
 * IDENTITY: the persona is Yeshua Throne (the founder), payee
 * `rh_yeshua_throne_don`, KYC-approved, bank-linked, PROVISIONED on the
 * sandbox rail.
 *
 * PORTFOLIO (founder-locked targets, integer cents):
 *   available   330,000,000           ($3,300,000.00)
 *   pending      65,000,000           ($650,000.00)
 *   reserve   100,000,000,000       ($1,000,000,000.00)
 *
 * HOW each amount is produced (the founder's integrity test — all real
 * paths, asserted at seed time):
 *   RESERVE — five `calculateUdrSplits` runs (settle: false) whose creator
 *   allocation is backup-withheld at 24% because the seeded tax profile has
 *   no verified TIN/W-9 (locked semantic #4); calculateUdrSplits credits
 *   each withheld amount to the creator's reserve vault bucket.
 *   PENDING — the same runs credit the creator's post-withholding net to
 *   the pending bucket (non-settle credits land in pending); the pending
 *   bucket is then moved to available by ONE `releaseVaultPending`, and
 *   finally `payoutFromVault` drains available into pending for two
 *   IN-FLIGHT payouts (two historical payouts are settled through
 *   `settleVaultPayout`, clearing their pending).
 *   AVAILABLE — the residual: released net minus all four payout holds.
 *
 *   sum(creator_allocations) + company_dust === gross holds per run by
 *   construction (the engine's zero-balance invariant; the 50/50 creator/
 *   label splits are exact, so company dust is 0 on every run).
 *
 * Every date is fixed — the demo view is deterministic. The final store
 * state is ASSERTED against the targets; any engine drift fails the boot
 * loudly instead of rendering wrong numbers.
 */

import { getSdk, indexAsset } from '@/lib/sdk';
import { calculateUdrSplits } from '@/lib/server/udrSplits';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { setStore } from '@/lib/server/store';
import type { SessionCreator } from '@/lib/server/sessionCreator';
import { payoutFromVault, releaseVaultPending, settleVaultPayout } from '@/modules/vaults/engine';

/** The demo persona — the seeded creator rendered by every demo surface. */
export const DEV_SEED_CREATOR: SessionCreator = {
  payee_id: 'rh_yeshua_throne_don',
  stage_name: 'Yeshua Throne',
  kyc_status: 'APPROVED',
  bank_account_linked: true,
  provisioning_status: 'PROVISIONED',
};

/** The persona's seeded identity tag (rendered on demo identity surfaces only). */
export const DEV_SEED_UCT = 'UCT-US-2026-8C4F1E7A-A9';

/** The founder-locked portfolio targets the seed must land on, exactly. */
export const DEV_SEED_TARGETS = {
  available_cents: 330_000_000,
  pending_cents: 65_000_000,
  reserve_cents: 100_000_000_000,
} as const;

/**
 * The env flag — explicit, off by default, documented in .env.example. On
 * for DON_DEV_SEED=1 (local dev/e2e) and for Vercel preview deployments.
 */
export function isDevSeedMode(): boolean {
  // The preview door: Vercel preview deployments must render the populated
  // seeded dashboard with zero user actions (standing directive), and the
  // preview deployment has no Supabase credentials — the seeded in-memory
  // persona is the only honest preview experience. VERCEL_ENV is
  // 'production' on prod, so the gate there stays fail-closed.
  return process.env.DON_DEV_SEED === '1' || process.env.VERCEL_ENV === 'preview';
}

/** Deterministic seed clock — every record lands on one of these instants or a densifier day slot. */
const SEED_INSTANTS = {
  spotify_aug: '2026-08-20T12:00:00.000Z',
  youtube_aug: '2026-08-29T12:00:00.000Z',
  amazon_aug: '2026-08-30T12:00:00.000Z',
  spotify_sep: '2026-09-06T14:00:00.000Z',
  bandcamp: '2026-09-07T16:30:00.000Z',
  release: '2026-09-08T09:00:00.000Z',
  payout_rtp: '2026-09-08T14:00:00.000Z',
  payout_ach: '2026-09-08T14:05:00.000Z',
  settle_rtp: '2026-09-09T10:00:00.000Z',
  settle_ach: '2026-09-09T10:05:00.000Z',
  payout_rtp_2: '2026-09-10T14:00:00.000Z',
  payout_ach_2: '2026-09-10T14:05:00.000Z',
  sports: '2026-09-11T15:00:00.000Z',
  tournament: '2026-09-12T15:00:00.000Z',
  esports: '2026-09-13T15:00:00.000Z',
  social: '2026-09-14T15:00:00.000Z',
  sponsorship: '2026-09-15T15:00:00.000Z',
  film: '2026-09-16T15:00:00.000Z',
  tv: '2026-09-17T15:00:00.000Z',
  podcast: '2026-09-18T15:00:00.000Z',
  live: '2026-09-19T15:00:00.000Z',
  publishing: '2026-09-20T15:00:00.000Z',
  // ── The intelligence widening instants ──────────────────────────────
  // Second settlements for the ten generation-4 entities (staggered across
  // 2026-09-21), and both settlements for the eighteen entities the ledger
  // had never credited (wave one staggered across 2026-09-13…18, wave two
  // across 2026-09-22). Fixed, deterministic — the trend window is rendered
  // exactly as these instants carry it, never smoothed.
  sports_2: '2026-09-21T15:00:00.000Z',
  tournament_2: '2026-09-21T15:30:00.000Z',
  esports_2: '2026-09-21T16:00:00.000Z',
  social_2: '2026-09-21T16:30:00.000Z',
  sponsorship_2: '2026-09-21T17:00:00.000Z',
  film_2: '2026-09-21T17:30:00.000Z',
  tv_2: '2026-09-21T18:00:00.000Z',
  podcast_2: '2026-09-21T18:30:00.000Z',
  live_2: '2026-09-21T19:00:00.000Z',
  publishing_2: '2026-09-21T19:30:00.000Z',
  flm2_p1: '2026-09-13T09:30:00.000Z',
  flm3_p1: '2026-09-13T10:30:00.000Z',
  flm4_p1: '2026-09-14T09:30:00.000Z',
  flm5_p1: '2026-09-14T10:30:00.000Z',
  flm6_p1: '2026-09-15T09:30:00.000Z',
  flm7_p1: '2026-09-15T10:30:00.000Z',
  lve2_p1: '2026-09-16T09:30:00.000Z',
  lve3_p1: '2026-09-16T10:30:00.000Z',
  lve4_p1: '2026-09-16T11:30:00.000Z',
  lve9_p1: '2026-09-17T09:30:00.000Z',
  bok1_p1: '2026-09-17T10:30:00.000Z',
  ltr1_p1: '2026-09-17T11:30:00.000Z',
  lit1_p1: '2026-09-18T09:30:00.000Z',
  lit2_p1: '2026-09-18T10:30:00.000Z',
  lit3_p1: '2026-09-18T11:30:00.000Z',
  lit4_p1: '2026-09-18T12:30:00.000Z',
  lit5_p1: '2026-09-18T13:30:00.000Z',
  lit6_p1: '2026-09-18T14:30:00.000Z',
  flm2_p2: '2026-09-22T09:00:00.000Z',
  flm3_p2: '2026-09-22T09:30:00.000Z',
  flm4_p2: '2026-09-22T10:00:00.000Z',
  flm5_p2: '2026-09-22T10:30:00.000Z',
  flm6_p2: '2026-09-22T11:00:00.000Z',
  flm7_p2: '2026-09-22T11:30:00.000Z',
  lve2_p2: '2026-09-22T12:00:00.000Z',
  lve3_p2: '2026-09-22T12:30:00.000Z',
  lve4_p2: '2026-09-22T13:00:00.000Z',
  lve9_p2: '2026-09-22T13:30:00.000Z',
  bok1_p2: '2026-09-22T14:00:00.000Z',
  ltr1_p2: '2026-09-22T14:30:00.000Z',
  lit1_p2: '2026-09-22T15:00:00.000Z',
  lit2_p2: '2026-09-22T15:30:00.000Z',
  lit3_p2: '2026-09-22T16:00:00.000Z',
  lit4_p2: '2026-09-22T16:30:00.000Z',
  lit5_p2: '2026-09-22T17:00:00.000Z',
  lit6_p2: '2026-09-22T17:30:00.000Z',
} as const;

/** Creator 50% — label 50%: exact splits, zero dust on every run. */
const CREATOR_BPS = 5_000;
const LABEL_BPS = 5_000;

/** The settled pending bucket released to available (Σ post-withholding nets). */
const RELEASED_NET_CENTS = 316_666_666_668;

/**
 * The seeded royalty runs — the founder persona's five music-platform
 * settlements plus the generation-4 multi-industry runs (the athlete
 * guarantee, the tournament purse, the stream yield, the social yield,
 * the sponsorship deal). The work reference of record on EVERY run is the
 * bound entity template of the underlying asset (the analytics industry
 * cut's join key), and every gross is an even number of cents so the
 * splits are exact.
 *
 * The music runs clear 50/50 to the persona (creator, withheld) and the
 * demo rights group (label). The generation-4 runs clear 100% to the demo
 * rights group — the founder persona's pinned vault targets stay exact,
 * and the demo-data badge discloses all of it.
 *
 * The two totals that matter for the persona's vault:
 *   Σ creator allocations = 416,666,666,668
 *   Σ withheld (24% of each allocation, no verified TIN) = 100,000,000,000
 */
/** One seeded settlement — the shape both run tables share. */
interface SeedRun {
  source: string;
  period: string;
  at: string;
  workId: string;
  workTitle: string;
  gross: number;
  withCreator: boolean;
}

const SEED_RUNS: ReadonlyArray<SeedRun> = [
  // The music-platform settlement story (the persona's five runs).
  { source: 'Spotify', period: '2026-08', at: SEED_INSTANTS.spotify_aug, workId: 'TPL-MUS-001', workTitle: 'Midnight Clear', gross: 200_000_000_000, withCreator: true },
  { source: 'YouTube Music', period: '2026-08', at: SEED_INSTANTS.youtube_aug, workId: 'TPL-MUS-001', workTitle: 'Gold Hours', gross: 200_000_000_000, withCreator: true },
  { source: 'Amazon Music', period: '2026-08', at: SEED_INSTANTS.amazon_aug, workId: 'TPL-MUS-001', workTitle: 'Sovereign Season', gross: 200_000_000_000, withCreator: true },
  { source: 'Spotify', period: '2026-09', at: SEED_INSTANTS.spotify_sep, workId: 'TPL-MUS-001', workTitle: 'Midnight Clear', gross: 200_000_000_000, withCreator: true },
  { source: 'Bandcamp', period: '2026-09', at: SEED_INSTANTS.bandcamp, workId: 'TPL-MUS-001', workTitle: 'Gold Hours', gross: 33_333_333_336, withCreator: true },
  // The generation-4 multi-industry runs (demo-disclosed, canon-plausible:
  // the athlete guarantee, the tournament purse, the stream yield, the
  // social yield, the sponsorship deal).
  { source: 'Nike', period: '2026-09', at: SEED_INSTANTS.sports, workId: 'TPL-SPT-001', workTitle: 'Nike Basketball Endorsement', gross: 240_000_000, withCreator: false },
  { source: 'PGA Tour', period: '2026-09', at: SEED_INSTANTS.tournament, workId: 'TPL-TRN-001', workTitle: 'PGA Tour Purse Settlement', gross: 1_250_000_000, withCreator: false },
  { source: 'Twitch', period: '2026-09', at: SEED_INSTANTS.esports, workId: 'TPL-ESX-001', workTitle: 'Fortnite Stream Monetization', gross: 8_640_000, withCreator: false },
  { source: 'TikTok', period: '2026-09', at: SEED_INSTANTS.social, workId: 'TPL-SOC-001', workTitle: 'Content Match Monetization', gross: 1_200_000, withCreator: false },
  { source: 'Nike', period: '2026-09', at: SEED_INSTANTS.sponsorship, workId: 'TPL-SPN-001', workTitle: 'Nike Brand Partnership', gross: 95_000_000, withCreator: false },
  // The flow-kind widening runs (2026-09-22 founder directive — the page
  // must read like the whole entertainment world clears through Covnant):
  // every industry class represented through the same label-only demo
  // allocation, so the by-industry cut shows all ten class tags and the
  // by-flow-kind cut shows every registered kind. Sources are store-side
  // counterparty strings of record (ledger drilldowns); the analytics
  // layer never renders them.
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.film, workId: 'TPL-FLM-001', workTitle: 'Theatrical Distribution Settlement', gross: 420_000_000, withCreator: false },
  { source: 'Broadcast Partners', period: '2026-09', at: SEED_INSTANTS.tv, workId: 'TPL-TV-001', workTitle: 'Broadcast Ad Insert Settlement', gross: 310_000_000, withCreator: false },
  { source: 'Apple Podcasts', period: '2026-09', at: SEED_INSTANTS.podcast, workId: 'TPL-PDC-001', workTitle: 'Podcast Feed Settlement', gross: 96_400_000, withCreator: false },
  { source: 'Ticketmaster', period: '2026-09', at: SEED_INSTANTS.live, workId: 'TPL-LVE-001', workTitle: 'Box Office Settlement', gross: 236_800_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.publishing, workId: 'TPL-PUB-001', workTitle: 'Print Royalty Settlement', gross: 84_200_000, withCreator: false },
  // ── The intelligence widening runs (2026-09-23) ──────────────────────
  // Per-entity journal histories for the Entity Intelligence tab: every
  // registered atomic entity clears through at least two staggered
  // settlements (a real trend series, never a single point), and the
  // multi-entity class families rank against real cohort totals. All
  // label-only — the founder persona's pinned vault targets stay exact —
  // and every value is demo-disclosed through the DEMO DATA badge.
  // Second settlements for the ten generation-4 entities.
  { source: 'Nike', period: '2026-09', at: SEED_INSTANTS.sports_2, workId: 'TPL-SPT-001', workTitle: 'Nike Basketball Endorsement', gross: 96_000_000, withCreator: false },
  { source: 'PGA Tour', period: '2026-09', at: SEED_INSTANTS.tournament_2, workId: 'TPL-TRN-001', workTitle: 'PGA Tour Purse Settlement', gross: 500_000_000, withCreator: false },
  { source: 'Twitch', period: '2026-09', at: SEED_INSTANTS.esports_2, workId: 'TPL-ESX-001', workTitle: 'Fortnite Stream Monetization', gross: 4_320_000, withCreator: false },
  { source: 'TikTok', period: '2026-09', at: SEED_INSTANTS.social_2, workId: 'TPL-SOC-001', workTitle: 'Content Match Monetization', gross: 600_000, withCreator: false },
  { source: 'Nike', period: '2026-09', at: SEED_INSTANTS.sponsorship_2, workId: 'TPL-SPN-001', workTitle: 'Nike Brand Partnership', gross: 47_500_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.film_2, workId: 'TPL-FLM-001', workTitle: 'Theatrical Distribution Settlement', gross: 265_000_000, withCreator: false },
  { source: 'Broadcast Partners', period: '2026-09', at: SEED_INSTANTS.tv_2, workId: 'TPL-TV-001', workTitle: 'Broadcast Ad Insert Settlement', gross: 124_000_000, withCreator: false },
  { source: 'Apple Podcasts', period: '2026-09', at: SEED_INSTANTS.podcast_2, workId: 'TPL-PDC-001', workTitle: 'Podcast Feed Settlement', gross: 38_560_000, withCreator: false },
  { source: 'Ticketmaster', period: '2026-09', at: SEED_INSTANTS.live_2, workId: 'TPL-LVE-001', workTitle: 'Box Office Settlement', gross: 118_400_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.publishing_2, workId: 'TPL-PUB-001', workTitle: 'Print Royalty Settlement', gross: 41_000_000, withCreator: false },
  // The FILM family — six further registered films, two staggered
  // theatrical settlements each (cohort of seven).
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm2_p1, workId: 'TPL-FLM-002', workTitle: 'Independent Feature Distribution Settlement', gross: 180_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm3_p1, workId: 'TPL-FLM-003', workTitle: 'Festival Acquisition Settlement', gross: 220_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm4_p1, workId: 'TPL-FLM-004', workTitle: 'Studio Release Settlement', gross: 310_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm5_p1, workId: 'TPL-FLM-005', workTitle: 'Platform Premiere Settlement', gross: 140_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm6_p1, workId: 'TPL-FLM-006', workTitle: 'Wide Release Settlement', gross: 260_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm7_p1, workId: 'TPL-FLM-007', workTitle: 'Limited Release Settlement', gross: 205_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm2_p2, workId: 'TPL-FLM-002', workTitle: 'Independent Feature Distribution Settlement', gross: 150_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm3_p2, workId: 'TPL-FLM-003', workTitle: 'Festival Acquisition Settlement', gross: 145_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm4_p2, workId: 'TPL-FLM-004', workTitle: 'Studio Release Settlement', gross: 190_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm5_p2, workId: 'TPL-FLM-005', workTitle: 'Platform Premiere Settlement', gross: 115_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm6_p2, workId: 'TPL-FLM-006', workTitle: 'Wide Release Settlement', gross: 95_000_000, withCreator: false },
  { source: 'Meridian Cinemas', period: '2026-09', at: SEED_INSTANTS.flm7_p2, workId: 'TPL-FLM-007', workTitle: 'Limited Release Settlement', gross: 88_000_000, withCreator: false },
  // The LIVE family — four further registered stage performances, two
  // staggered box-office settlements each (cohort of five).
  { source: 'Ticketmaster', period: '2026-09', at: SEED_INSTANTS.lve2_p1, workId: 'TPL-LVE-002', workTitle: 'Arena Residency Settlement', gross: 402_600_000, withCreator: false },
  { source: 'Ticketmaster', period: '2026-09', at: SEED_INSTANTS.lve3_p1, workId: 'TPL-LVE-003', workTitle: 'Theater Tour Settlement', gross: 341_500_000, withCreator: false },
  { source: 'Ticketmaster', period: '2026-09', at: SEED_INSTANTS.lve4_p1, workId: 'TPL-LVE-004', workTitle: 'Club Tour Settlement', gross: 188_900_000, withCreator: false },
  { source: 'Ticketmaster', period: '2026-09', at: SEED_INSTANTS.lve9_p1, workId: 'TPL-LVE-009', workTitle: 'Festival Stage Settlement', gross: 96_700_000, withCreator: false },
  { source: 'Ticketmaster', period: '2026-09', at: SEED_INSTANTS.lve2_p2, workId: 'TPL-LVE-002', workTitle: 'Arena Residency Settlement', gross: 176_900_000, withCreator: false },
  { source: 'Ticketmaster', period: '2026-09', at: SEED_INSTANTS.lve3_p2, workId: 'TPL-LVE-003', workTitle: 'Theater Tour Settlement', gross: 156_300_000, withCreator: false },
  { source: 'Ticketmaster', period: '2026-09', at: SEED_INSTANTS.lve4_p2, workId: 'TPL-LVE-004', workTitle: 'Club Tour Settlement', gross: 74_200_000, withCreator: false },
  { source: 'Ticketmaster', period: '2026-09', at: SEED_INSTANTS.lve9_p2, workId: 'TPL-LVE-009', workTitle: 'Festival Stage Settlement', gross: 42_300_000, withCreator: false },
  // The PUBLISHING family — nine further registered literary works, two
  // staggered print settlements each (cohort of nine). THE DELIBERATE TIE:
  // TPL-LIT-003 (65_000_000 + 27_000_000) and TPL-LIT-004 (58_000_000 +
  // 34_000_000) clear the SAME exact total, 92_000_000 cents, from
  // different point values — the standard-competition rank-sharing (both
  // rank 3 of 9, rank 4 vacant) is visible in the demo UI.
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.bok1_p1, workId: 'TPL-BOK-001', workTitle: 'Hardcover Royalty Settlement', gross: 58_500_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.ltr1_p1, workId: 'TPL-LTR-001', workTitle: 'Literary Magazine Settlement', gross: 31_400_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit1_p1, workId: 'TPL-LIT-001', workTitle: 'Frontlist Print Royalty Settlement', gross: 72_600_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit2_p1, workId: 'TPL-LIT-002', workTitle: 'Backlist Print Royalty Settlement', gross: 47_300_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit3_p1, workId: 'TPL-LIT-003', workTitle: 'Serialized Print Royalty Settlement', gross: 65_000_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit4_p1, workId: 'TPL-LIT-004', workTitle: 'Translation Print Royalty Settlement', gross: 58_000_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit5_p1, workId: 'TPL-LIT-005', workTitle: 'Academic Print Royalty Settlement', gross: 23_800_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit6_p1, workId: 'TPL-LIT-006', workTitle: 'Audiobook-Print Royalty Settlement', gross: 16_900_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.bok1_p2, workId: 'TPL-BOK-001', workTitle: 'Hardcover Royalty Settlement', gross: 26_000_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.ltr1_p2, workId: 'TPL-LTR-001', workTitle: 'Literary Magazine Settlement', gross: 14_800_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit1_p2, workId: 'TPL-LIT-001', workTitle: 'Frontlist Print Royalty Settlement', gross: 33_900_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit2_p2, workId: 'TPL-LIT-002', workTitle: 'Backlist Print Royalty Settlement', gross: 21_700_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit3_p2, workId: 'TPL-LIT-003', workTitle: 'Serialized Print Royalty Settlement', gross: 27_000_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit4_p2, workId: 'TPL-LIT-004', workTitle: 'Translation Print Royalty Settlement', gross: 34_000_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit5_p2, workId: 'TPL-LIT-005', workTitle: 'Academic Print Royalty Settlement', gross: 11_600_000, withCreator: false },
  { source: 'Reader Platforms', period: '2026-09', at: SEED_INSTANTS.lit6_p2, workId: 'TPL-LIT-006', workTitle: 'Audiobook-Print Royalty Settlement', gross: 8_300_000, withCreator: false },
];

// ── The analytics densification runs (2026-09-23) ───────────────────────────
// Label-only settlements on the days the tables above leave empty, so the
// company analytics area chart reads as a daily CURVE. The rotation walks the
// nineteen non-music, non-publishing entities (the publishing cohort's
// deliberate tie must not move; MUSIC's five-run story must not grow), 2-3
// entities per day at staggered slot hours — every day 2026-08-21 through
// 2026-09-23 carries journal points. The per-entity additions are built so
// each multi-entity cohort keeps its internal order exactly: every film's
// three densifier points sum to 157,000,000 cents and every live entity's to
// 111,000,000, so the cleared-total gaps between siblings never cross.

/**
 * The densifier day's settlement slots — 09:30, 10:30, 11:30 UTC, clear of
 * every story instant already in the ledger.
 */
function densifierInstant(day: string, slot: number): string {
  return `${day}T${String(9 + slot).padStart(2, '0')}:30:00.000Z`;
}

/** A densifier run — day + slot expand to the deterministic instant; period derives from the day. */
interface DensifierRun {
  readonly day: string;
  readonly slot: number;
  readonly source: string;
  readonly workId: string;
  readonly workTitle: string;
  readonly gross: number;
}

const DENSIFIER_RUNS: ReadonlyArray<DensifierRun> = [
  // The FILM rotation — three further distribution settlements per release
  // (the lead film TPL-FLM-001 takes a fourth), sums equal at 157,000,000.
  { day: '2026-08-21', slot: 0, source: 'Meridian Cinemas', workId: 'TPL-FLM-001', workTitle: 'Theatrical Distribution Settlement', gross: 61_000_000 },
  { day: '2026-08-21', slot: 1, source: 'Meridian Cinemas', workId: 'TPL-FLM-002', workTitle: 'Independent Feature Distribution Settlement', gross: 58_000_000 },
  { day: '2026-08-21', slot: 2, source: 'Meridian Cinemas', workId: 'TPL-FLM-003', workTitle: 'Festival Acquisition Settlement', gross: 63_000_000 },
  { day: '2026-08-22', slot: 0, source: 'Meridian Cinemas', workId: 'TPL-FLM-004', workTitle: 'Studio Release Settlement', gross: 65_000_000 },
  { day: '2026-08-22', slot: 1, source: 'Meridian Cinemas', workId: 'TPL-FLM-005', workTitle: 'Platform Premiere Settlement', gross: 57_000_000 },
  { day: '2026-08-22', slot: 2, source: 'Meridian Cinemas', workId: 'TPL-FLM-006', workTitle: 'Wide Release Settlement', gross: 59_000_000 },
  { day: '2026-08-23', slot: 0, source: 'Meridian Cinemas', workId: 'TPL-FLM-007', workTitle: 'Limited Release Settlement', gross: 62_000_000 },
  { day: '2026-08-27', slot: 1, source: 'Meridian Cinemas', workId: 'TPL-FLM-001', workTitle: 'Theatrical Distribution Settlement', gross: 52_000_000 },
  { day: '2026-08-27', slot: 2, source: 'Meridian Cinemas', workId: 'TPL-FLM-002', workTitle: 'Independent Feature Distribution Settlement', gross: 55_000_000 },
  { day: '2026-08-28', slot: 0, source: 'Meridian Cinemas', workId: 'TPL-FLM-003', workTitle: 'Festival Acquisition Settlement', gross: 51_000_000 },
  { day: '2026-08-28', slot: 1, source: 'Meridian Cinemas', workId: 'TPL-FLM-004', workTitle: 'Studio Release Settlement', gross: 49_000_000 },
  { day: '2026-08-28', slot: 2, source: 'Meridian Cinemas', workId: 'TPL-FLM-005', workTitle: 'Platform Premiere Settlement', gross: 54_000_000 },
  { day: '2026-08-29', slot: 0, source: 'Meridian Cinemas', workId: 'TPL-FLM-006', workTitle: 'Wide Release Settlement', gross: 53_000_000 },
  { day: '2026-08-29', slot: 1, source: 'Meridian Cinemas', workId: 'TPL-FLM-007', workTitle: 'Limited Release Settlement', gross: 50_000_000 },
  { day: '2026-09-03', slot: 1, source: 'Meridian Cinemas', workId: 'TPL-FLM-001', workTitle: 'Theatrical Distribution Settlement', gross: 44_000_000 },
  { day: '2026-09-03', slot: 2, source: 'Meridian Cinemas', workId: 'TPL-FLM-002', workTitle: 'Independent Feature Distribution Settlement', gross: 44_000_000 },
  { day: '2026-09-04', slot: 0, source: 'Meridian Cinemas', workId: 'TPL-FLM-003', workTitle: 'Festival Acquisition Settlement', gross: 43_000_000 },
  { day: '2026-09-04', slot: 1, source: 'Meridian Cinemas', workId: 'TPL-FLM-004', workTitle: 'Studio Release Settlement', gross: 43_000_000 },
  { day: '2026-09-04', slot: 2, source: 'Meridian Cinemas', workId: 'TPL-FLM-005', workTitle: 'Platform Premiere Settlement', gross: 46_000_000 },
  { day: '2026-09-05', slot: 0, source: 'Meridian Cinemas', workId: 'TPL-FLM-006', workTitle: 'Wide Release Settlement', gross: 45_000_000 },
  { day: '2026-09-05', slot: 1, source: 'Meridian Cinemas', workId: 'TPL-FLM-007', workTitle: 'Limited Release Settlement', gross: 45_000_000 },
  { day: '2026-09-23', slot: 1, source: 'Meridian Cinemas', workId: 'TPL-FLM-001', workTitle: 'Theatrical Distribution Settlement', gross: 40_000_000 },
  // The LIVE rotation — three further box-office settlements per stage
  // (sums equal at 111,000,000; cohort order preserved).
  { day: '2026-08-23', slot: 1, source: 'Ticketmaster', workId: 'TPL-LVE-001', workTitle: 'Box Office Settlement', gross: 37_000_000 },
  { day: '2026-08-23', slot: 2, source: 'Ticketmaster', workId: 'TPL-LVE-002', workTitle: 'Arena Residency Settlement', gross: 38_000_000 },
  { day: '2026-08-24', slot: 0, source: 'Ticketmaster', workId: 'TPL-LVE-003', workTitle: 'Theater Tour Settlement', gross: 36_000_000 },
  { day: '2026-08-24', slot: 1, source: 'Ticketmaster', workId: 'TPL-LVE-004', workTitle: 'Club Tour Settlement', gross: 35_000_000 },
  { day: '2026-08-24', slot: 2, source: 'Ticketmaster', workId: 'TPL-LVE-009', workTitle: 'Festival Stage Settlement', gross: 40_000_000 },
  { day: '2026-08-30', slot: 0, source: 'Ticketmaster', workId: 'TPL-LVE-001', workTitle: 'Box Office Settlement', gross: 36_000_000 },
  { day: '2026-08-30', slot: 1, source: 'Ticketmaster', workId: 'TPL-LVE-002', workTitle: 'Arena Residency Settlement', gross: 35_000_000 },
  { day: '2026-08-31', slot: 0, source: 'Ticketmaster', workId: 'TPL-LVE-003', workTitle: 'Theater Tour Settlement', gross: 38_000_000 },
  { day: '2026-08-31', slot: 1, source: 'Ticketmaster', workId: 'TPL-LVE-004', workTitle: 'Club Tour Settlement', gross: 38_000_000 },
  { day: '2026-08-31', slot: 2, source: 'Ticketmaster', workId: 'TPL-LVE-009', workTitle: 'Festival Stage Settlement', gross: 36_000_000 },
  { day: '2026-09-05', slot: 2, source: 'Ticketmaster', workId: 'TPL-LVE-001', workTitle: 'Box Office Settlement', gross: 38_000_000 },
  { day: '2026-09-08', slot: 0, source: 'Ticketmaster', workId: 'TPL-LVE-002', workTitle: 'Arena Residency Settlement', gross: 38_000_000 },
  { day: '2026-09-08', slot: 1, source: 'Ticketmaster', workId: 'TPL-LVE-003', workTitle: 'Theater Tour Settlement', gross: 37_000_000 },
  { day: '2026-09-09', slot: 0, source: 'Ticketmaster', workId: 'TPL-LVE-004', workTitle: 'Club Tour Settlement', gross: 38_000_000 },
  { day: '2026-09-09', slot: 1, source: 'Ticketmaster', workId: 'TPL-LVE-009', workTitle: 'Festival Stage Settlement', gross: 35_000_000 },
  // The single-entity rotation — TV, podcast, and the connective brand
  // money, three further settlements each (cohorts of one: only the totals
  // grow, the ranks cannot move).
  { day: '2026-08-25', slot: 0, source: 'Broadcast Partners', workId: 'TPL-TV-001', workTitle: 'Broadcast Ad Insert Settlement', gross: 58_000_000 },
  { day: '2026-08-25', slot: 1, source: 'Apple Podcasts', workId: 'TPL-PDC-001', workTitle: 'Podcast Feed Settlement', gross: 31_000_000 },
  { day: '2026-08-25', slot: 2, source: 'Nike', workId: 'TPL-SPT-001', workTitle: 'Nike Basketball Endorsement', gross: 84_000_000 },
  { day: '2026-08-26', slot: 0, source: 'PGA Tour', workId: 'TPL-TRN-001', workTitle: 'PGA Tour Purse Settlement', gross: 210_000_000 },
  { day: '2026-08-26', slot: 1, source: 'Twitch', workId: 'TPL-ESX-001', workTitle: 'Fortnite Stream Monetization', gross: 1_440_000 },
  { day: '2026-08-26', slot: 2, source: 'TikTok', workId: 'TPL-SOC-001', workTitle: 'Content Match Monetization', gross: 240_000 },
  { day: '2026-08-27', slot: 0, source: 'Nike', workId: 'TPL-SPN-001', workTitle: 'Nike Brand Partnership', gross: 38_000_000 },
  { day: '2026-09-01', slot: 0, source: 'Broadcast Partners', workId: 'TPL-TV-001', workTitle: 'Broadcast Ad Insert Settlement', gross: 64_000_000 },
  { day: '2026-09-01', slot: 1, source: 'Apple Podcasts', workId: 'TPL-PDC-001', workTitle: 'Podcast Feed Settlement', gross: 36_000_000 },
  { day: '2026-09-01', slot: 2, source: 'Nike', workId: 'TPL-SPT-001', workTitle: 'Nike Basketball Endorsement', gross: 88_000_000 },
  { day: '2026-09-02', slot: 0, source: 'PGA Tour', workId: 'TPL-TRN-001', workTitle: 'PGA Tour Purse Settlement', gross: 225_000_000 },
  { day: '2026-09-02', slot: 1, source: 'Twitch', workId: 'TPL-ESX-001', workTitle: 'Fortnite Stream Monetization', gross: 1_920_000 },
  { day: '2026-09-02', slot: 2, source: 'TikTok', workId: 'TPL-SOC-001', workTitle: 'Content Match Monetization', gross: 320_000 },
  { day: '2026-09-03', slot: 0, source: 'Nike', workId: 'TPL-SPN-001', workTitle: 'Nike Brand Partnership', gross: 44_000_000 },
  { day: '2026-09-10', slot: 0, source: 'Broadcast Partners', workId: 'TPL-TV-001', workTitle: 'Broadcast Ad Insert Settlement', gross: 71_000_000 },
  { day: '2026-09-10', slot: 1, source: 'Apple Podcasts', workId: 'TPL-PDC-001', workTitle: 'Podcast Feed Settlement', gross: 42_000_000 },
  { day: '2026-09-19', slot: 0, source: 'Nike', workId: 'TPL-SPT-001', workTitle: 'Nike Basketball Endorsement', gross: 92_000_000 },
  { day: '2026-09-19', slot: 1, source: 'PGA Tour', workId: 'TPL-TRN-001', workTitle: 'PGA Tour Purse Settlement', gross: 240_000_000 },
  { day: '2026-09-20', slot: 0, source: 'Twitch', workId: 'TPL-ESX-001', workTitle: 'Fortnite Stream Monetization', gross: 2_400_000 },
  { day: '2026-09-20', slot: 1, source: 'TikTok', workId: 'TPL-SOC-001', workTitle: 'Content Match Monetization', gross: 400_000 },
  { day: '2026-09-23', slot: 0, source: 'Nike', workId: 'TPL-SPN-001', workTitle: 'Nike Brand Partnership', gross: 47_500_000 },
];

/** Expected per-run creator allocation (gross × 5,000 BPS — all exact). */
function expectedAllocation(gross: number): bigint {
  return BigInt(gross) * BigInt(CREATOR_BPS) / 10_000n;
}

/** Expected per-run backup withholding (allocation × 2,400 BPS, floored). */
function expectedWithheld(allocation: bigint): bigint {
  return allocation * 2_400n / 10_000n;
}

/**
 * Seed the two pre-cleared Sync Library demo works plus one CBT asset that
 * has not yet been submitted for sync licensing. The asset SHEETS are
 * registered through the engine's real mint path (`registerCBTAsset` — the
 * same server path the studio asset form uses, so titles hydrate through
 * getOrHydrateAsset); the two catalog rows are then pre-cleared via the
 * store seam, representing the gated administrator's pre-clearance decision.
 * "Crown Ledger" gets NO catalog row — the registration form's real target,
 * so the pending pre-clearance state is reachable through the true path.
 */
async function seedSyncLibrary(store: InMemoryStore): Promise<void> {
  const sdk = getSdk();
  const creatorHolder = {
    id: DEV_SEED_CREATOR.payee_id,
    name: DEV_SEED_CREATOR.stage_name,
    role: 'COMPOSER' as const,
    splitPercentage: 50,
    taxProfile: {
      taxFormType: 'W9_US_PERSON' as const,
      taxIdentifierEncrypted: 'seed-creator-tin',
      usTaxResident: true,
      isBackupWithholdingRequired: false,
      isVerified: true,
    },
    payoutRouting: {
      accountHolderName: DEV_SEED_CREATOR.stage_name,
      bankName: 'Sandbox Bank',
      accountNumberOrIBAN: '0001234567',
      routingOrBIC: '000000000',
      currency: 'USD',
      countryCode: 'US',
      planetaryJurisdiction: 'EARTH' as const,
      railType: 'ach',
    },
    confirmedByArtist: true,
  };
  const labelHolder = {
    id: 'rh_thrones_label_don',
    name: 'Thrones Rights Group',
    role: 'PUBLISHER' as const,
    splitPercentage: 50,
    taxProfile: {
      taxFormType: 'W9_US_PERSON' as const,
      taxIdentifierEncrypted: 'seed-label-ein',
      usTaxResident: true,
      isBackupWithholdingRequired: false,
      isVerified: true,
    },
    payoutRouting: {
      accountHolderName: 'Thrones Rights Group',
      bankName: 'Sandbox Bank',
      accountNumberOrIBAN: '0001234567',
      routingOrBIC: '000000000',
      currency: 'USD',
      countryCode: 'US',
      planetaryJurisdiction: 'EARTH' as const,
      railType: 'ach',
    },
    confirmedByArtist: true,
  };

  for (const sheet of [
    { title: 'Midnight Clear', genre: 'Cinematic R&B', bpm: 92, fee: 495_000, identifiers: { isrc: 'US-CVN-26-00001' } },
    { title: 'Gold Hours', genre: 'Alt Soul', bpm: 78, fee: 320_000, identifiers: { isrc: 'US-CVN-26-00002' } },
    // Registered in the CBT catalog only — NOT yet in the Sync Library.
    { title: 'Crown Ledger', genre: 'Neo Soul', bpm: 84, fee: null, identifiers: { isrc: 'US-CVN-26-00003' } },
  ]) {
    const { cbtCode } = await sdk.registerCBTAsset(sheet.title, 'MUSIC_TRACK', sheet.identifiers, [
      creatorHolder,
      labelHolder,
    ]);
    // The canonical registration flow populates the module-level shadow
    // index (see src/lib/sdk.ts header) — listAssets() reads it on the
    // demo door. Skipping this left the Sync Library enumerating nothing.
    const asset = sdk.getInMemoryAsset(cbtCode);
    if (asset) indexAsset(asset);
    if (sheet.fee === null) continue;
    await store.upsertSyncCatalogItem({
      cbt_code: cbtCode,
      is_pre_cleared: true,
      sync_fee_cents: sheet.fee,
      genre: sheet.genre,
      bpm: sheet.bpm,
      updated_at: SEED_INSTANTS.bandcamp,
    });
  }
}

/**
 * Run one seeded royalty through the REAL settlement orchestrator and
 * assert its withholding against the expected math before accepting it.
 */
async function seedRoyaltyRun(
  store: InMemoryStore,
  run: SeedRun,
): Promise<void> {
  const splits = run.withCreator
    ? [
        { payee_id: DEV_SEED_CREATOR.payee_id, payee_name: DEV_SEED_CREATOR.stage_name, role: 'creator' as const, share_bps: CREATOR_BPS },
        { payee_id: 'rh_thrones_label_don', payee_name: 'Thrones Rights Group', role: 'label' as const, share_bps: LABEL_BPS },
      ]
    : [
        // The generation-4 runs clear to the demo rights group of record —
        // the founder persona's pinned vault targets stay exact.
        { payee_id: 'rh_thrones_label_don', payee_name: 'Thrones Rights Group', role: 'label' as const, share_bps: 10_000 },
      ];
  const result = await calculateUdrSplits(
    store,
    {
      source: run.source,
      period: run.period,
      currency: 'USD',
      settle: false,
      rail: 'ach',
      line_items: [
        {
          work_id: run.workId,
          work_title: run.workTitle,
          amount_cents: run.gross,
          splits,
        },
      ],
    },
    new Date(run.at),
  );
  if (!result.ok) {
    throw new Error(`dev seed royalty run ${run.source} ${run.period} failed: ${result.code} ${result.message}`);
  }
  const expected = run.withCreator ? expectedWithheld(expectedAllocation(run.gross)) : 0n;
  const actual = result.value.withholding.reduce((sum, row) => sum + BigInt(row.withheld_cents), 0n);
  if (actual !== expected) {
    throw new Error(
      `dev seed withholding drift on ${run.source} ${run.period}: expected ${expected}, got ${actual}`,
    );
  }
}

/**
 * One freshly seeded in-memory store — the REAL engine paths
 * (calculateUdrSplits for the settlement chain, releaseVaultPending for the
 * release, payoutFromVault/settleVaultPayout for the payouts). The shared
 * half of both doors (the dev-seed boot and the demo door); a failed seed
 * throws — never a half-seeded store.
 */
export async function createSeededStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  try {
    await seedStore(store);
  } catch (error) {
    // A failed seed must never look like a working dashboard — fail loud.
    console.error('dev-seed: seeding failed:', error);
    throw error;
  }
  return store;
}

/**
 * Boots the seeded in-memory store. Idempotent per server boot: a fresh
 * InMemoryStore is seeded through the real engine paths every time. AWAITS
 * the full seed — instrumentation's register() awaits this, so no request
 * can observe a half-seeded store.
 */
let devSeedStore: InMemoryStore | null = null;

export async function bootDevSeedStore(): Promise<InMemoryStore> {
  const store = await createSeededStore();
  // Publish ONLY after the seed completes: an eager publish would hand a
  // concurrent first reader (page + layout render in parallel) an empty
  // vault — the $0.00 boot race the e2e caught on this branch.
  setStore(store);
  devSeedStore = store;
  console.error('dev-seed: The Don dashboard store seeded (DON_DEV_SEED=1).');
  return store;
}

/**
 * The dev-seed store for READ paths. Kept in THIS module rather than the
 * store.ts singleton because the instrumentation bundle and the SSR bundle
 * each compile their own copy of the store module — a store injected into
 * the singleton at boot never crosses that bundle boundary. Concurrent
 * first readers share ONE in-flight boot, and a failed boot is forgotten
 * so later reads retry instead of caching the rejection.
 */
let devSeedBoot: Promise<InMemoryStore> | null = null;

export function getSeededStore(): Promise<InMemoryStore> {
  if (devSeedStore !== null) {
    return Promise.resolve(devSeedStore);
  }
  if (devSeedBoot === null) {
    devSeedBoot = bootDevSeedStore().then((store) => store, (error) => {
      devSeedBoot = null;
      throw error;
    });
  }
  return devSeedBoot;
}

/**
 * The DEMO DOOR's store — the production face of the seeded door. The same
 * deterministic seed, booted into a DEDICATED instance that never touches
 * the setStore() singleton: a sessionless visitor must be able to open the
 * demo without swapping the persistence seam out from under real sessions —
 * after this boots, a signed-in creator's getStore() still reads Supabase
 * (or whatever was injected), never the demo data. The demo view is
 * read-only, so one shared instance per process is safe and keeps the
 * render deterministic.
 */
let demoDoorStore: InMemoryStore | null = null;
let demoDoorBoot: Promise<InMemoryStore> | null = null;

export function getDemoDoorStore(): Promise<InMemoryStore> {
  if (demoDoorStore !== null) {
    return Promise.resolve(demoDoorStore);
  }
  if (demoDoorBoot === null) {
    demoDoorBoot = createSeededStore().then((store) => {
      demoDoorStore = store;
      return store;
    }, (error) => {
      demoDoorBoot = null; // a failed boot is forgotten — later reads retry
      throw error;
    });
  }
  return demoDoorBoot;
}

async function seedStore(store: InMemoryStore): Promise<void> {
  const payee = DEV_SEED_CREATOR;

  // The reserve bucket starts at zero; settlement withholding builds it,
  // the release moves settled pending to available, payouts drain it.
  await store.upsertVault({
    payee_id: payee.payee_id,
    payee_name: payee.stage_name,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: SEED_INSTANTS.spotify_aug,
  });

  // The tax profile that DRIVES the reserve: no verified TIN, no W-9 on
  // file — backup withholding (24%) applies to every seeded allocation and
  // flows to the creator reserve (locked semantic #4).
  await store.upsertCreatorTaxProfile({
    creator_id: payee.payee_id,
    tin_verified: 0,
    w9_on_file: 0,
    updated_at: SEED_INSTANTS.spotify_aug,
  });

  // The persona's identity tag (rendered on demo identity surfaces only).
  await store.upsertCreatorUct({
    creatorId: payee.payee_id,
    uctNumber: DEV_SEED_UCT,
    isni: null,
  });

  // Sync Library demo works — real asset sheets + pre-cleared catalog rows.
  await seedSyncLibrary(store);

  // 1) RESERVE + PENDING: five real settlement runs (withheld → reserve,
  //    net → pending), then the analytics densifier's label-only days —
  //    the SAME engine path, so every curve point is a real settlement.
  for (const run of SEED_RUNS) {
    await seedRoyaltyRun(store, run);
  }
  for (const densifier of DENSIFIER_RUNS) {
    await seedRoyaltyRun(store, {
      source: densifier.source,
      period: densifier.day.slice(0, 7),
      at: densifierInstant(densifier.day, densifier.slot),
      workId: densifier.workId,
      workTitle: densifier.workTitle,
      gross: densifier.gross,
      withCreator: false,
    });
  }

  // 2) AVAILABLE: the creator releases the settled pending bucket.
  const released = await releaseVaultPending(
    store,
    payee.payee_id,
    RELEASED_NET_CENTS,
    new Date(SEED_INSTANTS.release),
  );
  if (!released.ok) {
    throw new Error(`dev seed: pending release failed: ${released.code} ${released.message}`);
  }

  // 3) The two HISTORICAL payouts — held, then settled (pending cleared).
  const rtpResult = await payoutFromVault(
    store,
    { payee_id: payee.payee_id, amount_cents: 200_000_000_000, rail: 'rtp' },
    new Date(SEED_INSTANTS.payout_rtp),
  );
  if (!rtpResult.ok) throw new Error(`dev seed: rtp payout failed: ${rtpResult.code}`);
  const achResult = await payoutFromVault(
    store,
    { payee_id: payee.payee_id, amount_cents: 116_271_666_668, rail: 'ach' },
    new Date(SEED_INSTANTS.payout_ach),
  );
  if (!achResult.ok) throw new Error(`dev seed: ach payout failed: ${achResult.code}`);
  const settleRtp = await settleVaultPayout(store, rtpResult.transfer.id, new Date(SEED_INSTANTS.settle_rtp));
  if (!settleRtp.ok) throw new Error(`dev seed: rtp settle failed: ${settleRtp.code}`);
  const settleAch = await settleVaultPayout(store, achResult.transfer.id, new Date(SEED_INSTANTS.settle_ach));
  if (!settleAch.ok) throw new Error(`dev seed: ach settle failed: ${settleAch.code}`);

  // 4) The two IN-FLIGHT payouts — held, never settled: they ARE the
  //    pending bucket on the dashboard.
  const inflightRtp = await payoutFromVault(
    store,
    { payee_id: payee.payee_id, amount_cents: 25_000_000, rail: 'rtp' },
    new Date(SEED_INSTANTS.payout_rtp_2),
  );
  if (!inflightRtp.ok) throw new Error(`dev seed: in-flight rtp failed: ${inflightRtp.code}`);
  const inflightAch = await payoutFromVault(
    store,
    { payee_id: payee.payee_id, amount_cents: 40_000_000, rail: 'ach' },
    new Date(SEED_INSTANTS.payout_ach_2),
  );
  if (!inflightAch.ok) throw new Error(`dev seed: in-flight ach failed: ${inflightAch.code}`);

  // 5) THE INTEGRITY GATE — the store must land exactly on the founder's
  //    targets; any drift fails the boot loudly.
  const vault = await store.getVault(payee.payee_id);
  if (!vault) throw new Error('dev seed: creator vault missing after seeding');
  const actual = {
    available: BigInt(vault.available_balance),
    pending: BigInt(vault.pending_balance),
    reserve: BigInt(vault.reserve_balance),
  };
  const target = {
    available: BigInt(DEV_SEED_TARGETS.available_cents),
    pending: BigInt(DEV_SEED_TARGETS.pending_cents),
    reserve: BigInt(DEV_SEED_TARGETS.reserve_cents),
  };
  for (const bucket of ['available', 'pending', 'reserve'] as const) {
    if (actual[bucket] !== target[bucket]) {
      throw new Error(
        `dev seed ${bucket} drift: expected ${target[bucket]}, got ${actual[bucket]}`,
      );
    }
  }
}

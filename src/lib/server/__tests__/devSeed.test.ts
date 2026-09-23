/**
 * The dev-seed boot — the flag gate and the seeded content through the real
 * engines: deterministic balances, the hash-chained GL, in-flight payouts,
 * the tax profile, and the demo persona. The intelligence widening
 * (2026-09-23) is pinned here too: every registered atomic entity trends
 * over at least two staggered journal points, the multi-entity class
 * families rank against real cohort totals, and the deliberate publishing
 * tie shares its rank exactly.
 *
 * THE FOUNDER'S INTEGRITY TEST (rendered here as store-level assertions):
 * the portfolio amounts are CONSTRUCTED through the real settlement engine
 * and read back from the store —
 *   reserve   100,000,000,000 — Σ 24% backup withholding credited to the
 *               creator's reserve bucket by calculateUdrSplits (no verified
 *               TIN/W-9 → locked semantic #4; the YTD and tax-escrow rows
 *               are the engine's own receipts).
 *   pending      65,000,000 — the two in-flight payout holds (payouts move
 *               available → pending; payout.settled clears pending).
 *   available   330,000,000 — the released residual after four payout holds.
 * No display string anywhere produces these numbers.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  bootDevSeedStore,
  DEV_SEED_CREATOR,
  DEV_SEED_TARGETS,
  DEV_SEED_UCT,
  isDevSeedMode,
} from '@/lib/server/devSeed';
import { entityIntelligence } from '@/lib/admin/entityIntelligence';
import { loadDashboardResolution, loadSessionDashboard } from '@/lib/server/dashboardLive';
import { getStore, setStore } from '@/lib/server/store';
import { InMemoryStore } from '@/lib/server/inMemoryStore';

// The boot replaces the process-wide store singleton — restore afterwards.
afterAll(() => {
  setStore(new InMemoryStore());
});

describe('isDevSeedMode — the explicit gate', () => {
  it('is on only for DON_DEV_SEED=1', () => {
    const original = process.env.DON_DEV_SEED;
    try {
      process.env.DON_DEV_SEED = '1';
      expect(isDevSeedMode()).toBe(true);
      process.env.DON_DEV_SEED = '0';
      expect(isDevSeedMode()).toBe(false);
      delete process.env.DON_DEV_SEED;
      expect(isDevSeedMode()).toBe(false);
      process.env.DON_DEV_SEED = 'true'; // not the documented value — off
      expect(isDevSeedMode()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.DON_DEV_SEED;
      else process.env.DON_DEV_SEED = original;
    }
  });
});

describe('isDevSeedMode — the Vercel preview door', () => {
  const originalDon = process.env.DON_DEV_SEED;
  const originalVercel = process.env.VERCEL_ENV;

  afterAll(() => {
    if (originalDon === undefined) delete process.env.DON_DEV_SEED;
    else process.env.DON_DEV_SEED = originalDon;
    if (originalVercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercel;
  });

  it('opens on Vercel preview deployments without DON_DEV_SEED — the demo renders under preview env', async () => {
    delete process.env.DON_DEV_SEED;
    process.env.VERCEL_ENV = 'preview';
    expect(isDevSeedMode()).toBe(true);

    // The resolver serves the seeded registered persona — the populated
    // dashboard renders immediately with zero user actions.
    const resolution = await loadSessionDashboard();
    expect(resolution.kind).toBe('registered');
    if (resolution.kind === 'registered') {
      expect(resolution.data.user.stage_name).toBe('Yeshua Throne');
    }

    // The PAGE door renders the same seeded persona as the demo view —
    // the seeded render IS the demo kind (exactly one badge rides on it).
    const pageResolution = await loadDashboardResolution();
    expect(pageResolution.kind).toBe('demo');
    if (pageResolution.kind === 'demo') {
      expect(pageResolution.data.user.stage_name).toBe('Yeshua Throne');
    }
  });

  it('opens the page-facing demo door in Vercel production — sessionless visitors see the seeded demo', async () => {
    delete process.env.DON_DEV_SEED;
    process.env.VERCEL_ENV = 'production';
    expect(isDevSeedMode()).toBe(false);

    // The API door stays fail-closed: no session → the anonymous gate,
    // exactly as the machine contract has always behaved.
    const apiResolution = await loadSessionDashboard();
    expect(apiResolution.kind === 'anonymous' || apiResolution.kind === 'unregistered').toBe(true);

    // The PAGE door is the demo door — VERCEL_ENV-agnostic: the sessionless
    // visitor lands straight on the populated seeded dashboard.
    const pageResolution = await loadDashboardResolution();
    expect(pageResolution.kind).toBe('demo');
    if (pageResolution.kind === 'demo') {
      expect(pageResolution.data.user.stage_name).toBe('Yeshua Throne');
      expect(pageResolution.data.vault.payee_id).toBe(DEV_SEED_CREATOR.payee_id);
    }
  });

  it('stays closed when both variables are unset — no demo outside preview', () => {
    delete process.env.DON_DEV_SEED;
    delete process.env.VERCEL_ENV;
    expect(isDevSeedMode()).toBe(false);
  });

  it('the explicit DON_DEV_SEED=1 switch still wins locally regardless of VERCEL_ENV', () => {
    process.env.DON_DEV_SEED = '1';
    process.env.VERCEL_ENV = 'production';
    expect(isDevSeedMode()).toBe(true);
  });
});

describe('bootDevSeedStore — the seeded content', () => {
  it('boots the seeded in-memory store through the real engines', async () => {
    await bootDevSeedStore();

    const store = getStore();
    expect(store).toBeInstanceOf(InMemoryStore);

    // THE PORTFOLIO — the founder's three targets, produced by the real
    // settlement/payout engine paths and read back from the store:
    //   available   330,000,000   pending   65,000,000   reserve 100,000,000,000
    const vault = await store.getVault(DEV_SEED_CREATOR.payee_id);
    expect(vault).toBeDefined();
    expect(vault!.available_balance).toBe(DEV_SEED_TARGETS.available_cents);
    expect(vault!.pending_balance).toBe(DEV_SEED_TARGETS.pending_cents);
    expect(vault!.reserve_balance).toBe(DEV_SEED_TARGETS.reserve_cents);

    // The withholding receipts — the engine's own records of the reserve
    // construction: YTD gross is Σ creator allocations (416,666,666,668) and
    // YTD withheld is the reserve itself (100,000,000,000 at 24%).
    const ytd = await store.getCreatorYtd(DEV_SEED_CREATOR.payee_id, 2026);
    expect(ytd).toBeDefined();
    expect(ytd!.gross_cents).toBe(416_666_666_668);
    expect(ytd!.withheld_cents).toBe(DEV_SEED_TARGETS.reserve_cents);

    // The tax-escrow rows — one per seeded settlement run, summing to the
    // same reserve total (the per-run receipts behind the YTD rollup).
    const escrows = await store.listTaxEscrowByCreator(DEV_SEED_CREATOR.payee_id, 2026);
    expect(escrows).toHaveLength(5);
    const escrowedTotal = escrows.reduce((sum, row) => sum + row.withheld_cents, 0);
    expect(escrowedTotal).toBe(DEV_SEED_TARGETS.reserve_cents);

    // The GL: one hundred twenty-six journals — one hundred nineteen royalty
    // ingests (the sixty-one story/widening runs of the tables above plus
    // the fifty-eight analytics-densifier runs that put 2-3 settlements on
    // every empty day from 2026-08-21 through 2026-09-23 — same engine
    // path, same label-only allocation) + one release + four payout holds +
    // two payout settlements, all posted — the hash chain links every
    // journal to its predecessor.
    const journals = await store.listGlJournals();
    expect(journals).toHaveLength(126);
    const bySequence = [...journals].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < bySequence.length; i += 1) {
      expect(bySequence[i].prev_hash).toBe(bySequence[i - 1].entry_hash);
    }
    expect(bySequence.every((journal) => journal.state === 'posted')).toBe(true);
    expect(bySequence.filter((journal) => journal.kind === 'royalty_ingest')).toHaveLength(119);
    expect(bySequence.filter((journal) => journal.kind === 'pending_release')).toHaveLength(1);
    expect(bySequence.filter((journal) => journal.kind === 'payout_hold')).toHaveLength(4);
    expect(bySequence.filter((journal) => journal.kind === 'payout_settled')).toHaveLength(2);

    // The payout holds — two historical (settled) and two in-flight on the
    // sandbox rails; the in-flight pair IS the pending bucket.
    const transfers = (await store.listBaasTransfers()).filter(
      (transfer) => transfer.payee_id === DEV_SEED_CREATOR.payee_id,
    );
    expect(transfers).toHaveLength(4);
    const holds = await Promise.all(transfers.map((transfer) => store.getPayoutHold(transfer.id)));
    expect(holds.filter((hold) => hold?.status === 'in_flight')).toHaveLength(2);
    expect(holds.filter((hold) => hold?.status === 'settled')).toHaveLength(2);

    // The tax profile — UNVERIFIED on purpose: it is what drives the 24%
    // backup withholding that builds the $1,000,000,000 reserve (locked
    // semantic #4). The readiness panel honestly shows the TODO.
    const profile = await store.getCreatorTaxProfile(DEV_SEED_CREATOR.payee_id);
    expect(profile?.tin_verified).toBe(0);
    expect(profile?.w9_on_file).toBe(0);

    // The persona's identity tag — the seeded UCT the identity surfaces read.
    const uct = await store.getCreatorUct(DEV_SEED_CREATOR.payee_id);
    expect(uct?.uctNumber).toBe(DEV_SEED_UCT);
  });

  it('seeds structurally deterministic — same ledger shape and balances per boot', async () => {
    await bootDevSeedStore();
    const first = await getStore().listGlJournals();
    const firstShape = first
      .map((journal) => `${journal.sequence}:${journal.kind}:${journal.ref_type}`)
      .sort();

    await bootDevSeedStore();
    const second = await getStore().listGlJournals();
    const secondShape = second
      .map((journal) => `${journal.sequence}:${journal.kind}:${journal.ref_type}`)
      .sort();

    // The payout-hold journals reference store-generated transfer ids, so
    // byte-identical hashes are not achievable through the real engines —
    // the promised determinism is the LEDGER SHAPE and the balances, and
    // the chain is valid within each boot (asserted above).
    expect(secondShape).toEqual(firstShape);
    const vault = await getStore().getVault(DEV_SEED_CREATOR.payee_id);
    expect(vault!.available_balance).toBe(DEV_SEED_TARGETS.available_cents);
  });
});

describe('bootDevSeedStore — the intelligence widening (per-entity journal histories)', () => {
  /**
   * The registered atomic entity seeds of record (the master store's entity
   * telemetry library) — every one must trend in the demo ledger. A class
   * that registers a new entity extends this list additively.
   */
  const REGISTERED_ENTITIES = [
    'TPL-MUS-001',
    'TPL-FLM-001', 'TPL-FLM-002', 'TPL-FLM-003', 'TPL-FLM-004', 'TPL-FLM-005', 'TPL-FLM-006', 'TPL-FLM-007',
    'TPL-TV-001',
    'TPL-PDC-001',
    'TPL-LVE-001', 'TPL-LVE-002', 'TPL-LVE-003', 'TPL-LVE-004', 'TPL-LVE-009',
    'TPL-PUB-001', 'TPL-BOK-001', 'TPL-LTR-001',
    'TPL-LIT-001', 'TPL-LIT-002', 'TPL-LIT-003', 'TPL-LIT-004', 'TPL-LIT-005', 'TPL-LIT-006',
    'TPL-SPT-001',
    'TPL-TRN-001',
    'TPL-ESX-001',
    'TPL-SOC-001',
    'TPL-SPN-001',
  ];

  it('gives every registered atomic entity a real trend series — at least two staggered journal points', async () => {
    await bootDevSeedStore();
    const store = getStore();
    for (const templateId of REGISTERED_ENTITIES) {
      const readout = await entityIntelligence(templateId, store);
      expect(readout, templateId).not.toBeNull();
      expect(readout?.trend.length, `${templateId} trend points`).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps every widening run label-only — the founder persona keeps its exact pinned vault', async () => {
    await bootDevSeedStore();
    const store = getStore();
    // The widening runs clear 100% to the demo rights group — the founder's
    // targets (and the five withholding receipts that build the reserve)
    // are untouched by the widening.
    const vault = await store.getVault(DEV_SEED_CREATOR.payee_id);
    expect(vault!.available_balance).toBe(DEV_SEED_TARGETS.available_cents);
    expect(vault!.pending_balance).toBe(DEV_SEED_TARGETS.pending_cents);
    expect(vault!.reserve_balance).toBe(DEV_SEED_TARGETS.reserve_cents);
    const escrows = await store.listTaxEscrowByCreator(DEV_SEED_CREATOR.payee_id, 2026);
    expect(escrows).toHaveLength(5);
  });

  it('ranks the film cohort across its seven cleared entities with a densified trend', async () => {
    await bootDevSeedStore();
    const store = getStore();
    const film = await entityIntelligence('TPL-FLM-001', store);
    expect(film?.class).toBe('FEATURE_FILM');
    // Two story settlements + four densifier points = 882,000,000 cents.
    expect(film?.cleared).toBe(882_000_000n);
    expect(film?.cohort).toEqual({ rank: 1n, of: 7n });
    // Six staggered settlements, newest first — the real series the
    // sparkline and area chart read. The densifier days slot BETWEEN the
    // story instants, never over them.
    expect(film?.trend).toEqual([
      { at: '2026-09-23T10:30:00.000Z', credit: 40_000_000n },
      { at: '2026-09-21T17:30:00.000Z', credit: 265_000_000n },
      { at: '2026-09-16T15:00:00.000Z', credit: 420_000_000n },
      { at: '2026-09-03T10:30:00.000Z', credit: 44_000_000n },
      { at: '2026-08-27T10:30:00.000Z', credit: 52_000_000n },
      { at: '2026-08-21T09:30:00.000Z', credit: 61_000_000n },
    ]);
    const runnerUp = await entityIntelligence('TPL-FLM-004', store);
    expect(runnerUp?.cohort).toEqual({ rank: 2n, of: 7n });
  });

  it('ranks the live cohort across its five cleared stage performances', async () => {
    await bootDevSeedStore();
    const store = getStore();
    const arena = await entityIntelligence('TPL-LVE-002', store);
    expect(arena?.class).toBe('STAGE_PERFORMANCE');
    // 579,500,000 story total + three densifier box-office points (equal
    // 111,000,000 additions hold every live sibling's rank).
    expect(arena?.cleared).toBe(690_500_000n);
    expect(arena?.cohort).toEqual({ rank: 1n, of: 5n });
    // The generation-4 box-office run (Sep 19) plus its widening second
    // plus the densifier points — five points, and rank 3 of 5.
    const legacy = await entityIntelligence('TPL-LVE-001', store);
    expect(legacy?.cleared).toBe(466_200_000n);
    expect(legacy?.cohort).toEqual({ rank: 3n, of: 5n });
    expect(legacy?.trend).toHaveLength(5);
  });

  it('clears the deliberate publishing tie — both works rank 3 of 9 and rank 4 is vacant', async () => {
    await bootDevSeedStore();
    const store = getStore();
    const lit3 = await entityIntelligence('TPL-LIT-003', store);
    const lit4 = await entityIntelligence('TPL-LIT-004', store);
    // Equal totals from different point values (65M + 27M vs 58M + 34M).
    expect(lit3?.cleared).toBe(92_000_000n);
    expect(lit4?.cleared).toBe(92_000_000n);
    expect(lit3?.cohort).toEqual({ rank: 3n, of: 9n });
    expect(lit4?.cohort).toEqual({ rank: 3n, of: 9n });
    // The next total below the tie skips the vacant rank 4 — standard
    // competition ranking, visible in the demo data.
    const bok = await entityIntelligence('TPL-BOK-001', store);
    expect(bok?.cleared).toBe(84_500_000n);
    expect(bok?.cohort).toEqual({ rank: 5n, of: 9n });
  });

  it('keeps the single-entity classes honest — cohort of one, promised read beside cleared', async () => {
    await bootDevSeedStore();
    const store = getStore();
    const athlete = await entityIntelligence('TPL-SPT-001', store);
    expect(athlete?.class).toBe('ATHLETE_CONTRACT');
    expect(athlete?.cohort).toEqual({ rank: 1n, of: 1n });
    // The widened cleared total (600,000,000 cents — the story pair plus
    // three densifier settlements) beside the canon guarantee (2,400,000
    // USD) — bigint end to end, units stated by the derivation and
    // formatted at display.
    expect(athlete?.cleared).toBe(600_000_000n);
    expect(athlete?.promisedUSD).toBe(2_400_000n);
    // The master recording's five-run music story is unchanged by the
    // widening — the trend stays five points, the total exact.
    const music = await entityIntelligence('TPL-MUS-001', store);
    expect(music?.trend).toHaveLength(5);
    expect(music?.cleared).toBe(833_333_333_336n);
    expect(music?.cohort).toEqual({ rank: 1n, of: 1n });
  });
});

describe('bootDevSeedStore — the analytics densification (the daily curve)', () => {
  it('covers every day from the first story run through today — no zero-journal day', async () => {
    await bootDevSeedStore();
    const store = getStore();
    const journals = (await store.listGlJournals()).filter(
      (journal) => journal.kind === 'royalty_ingest',
    );
    const countsByDay = new Map<string, number>();
    for (const journal of journals) {
      const day = journal.created_at.slice(0, 10);
      countsByDay.set(day, (countsByDay.get(day) ?? 0) + 1);
    }

    // Walk 2026-08-20 → 2026-09-23 deterministically (UTC days).
    const days: string[] = [];
    for (let t = Date.UTC(2026, 7, 20); t <= Date.UTC(2026, 8, 23); t += 86_400_000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    expect(days[0]).toBe('2026-08-20');
    expect(days[days.length - 1]).toBe('2026-09-23');

    // The curve never breaks: every single day carries at least one point.
    for (const day of days) {
      expect(countsByDay.get(day) ?? 0, `${day} coverage`).toBeGreaterThanOrEqual(1);
    }

    // Density across the trailing 30 days (2026-08-25 → 2026-09-23): most
    // days carry the design's 2-4 points, and the ONLY single-point days
    // are the four story days of record — the September music settlements
    // (Sep 6/7) and the generation-4 story runs (Sep 11/12) — while only
    // the widening pile-up days (Sep 18/21/22) exceed the band.
    const trailing = days.slice(-30);
    expect(trailing[0]).toBe('2026-08-25');
    const singlePointDays = trailing.filter((day) => countsByDay.get(day) === 1);
    expect(singlePointDays.sort()).toEqual(['2026-09-06', '2026-09-07', '2026-09-11', '2026-09-12']);
    const inBand = trailing.filter((day) => {
      const count = countsByDay.get(day) ?? 0;
      return count >= 2 && count <= 4;
    });
    expect(inBand).toHaveLength(23);
  });

  it('densifies the rotation entities to five-plus trend points and leaves the publishing tie at its deliberate two', async () => {
    await bootDevSeedStore();
    const store = getStore();
    // Every densifier-rotation entity now trends 5+ points (the lead film
    // six) — real sparkline material, every point a real settlement.
    for (const templateId of [
      'TPL-FLM-001', 'TPL-FLM-002', 'TPL-FLM-003', 'TPL-FLM-004', 'TPL-FLM-005', 'TPL-FLM-006', 'TPL-FLM-007',
      'TPL-TV-001', 'TPL-PDC-001',
      'TPL-LVE-001', 'TPL-LVE-002', 'TPL-LVE-003', 'TPL-LVE-004', 'TPL-LVE-009',
      'TPL-SPT-001', 'TPL-TRN-001', 'TPL-ESX-001', 'TPL-SOC-001', 'TPL-SPN-001',
    ]) {
      const readout = await entityIntelligence(templateId, store);
      expect(readout?.trend.length, `${templateId} densified points`).toBeGreaterThanOrEqual(5);
    }
    // The publishing cohort is deliberately NOT densified: exactly two
    // points each, and the deliberate tie stands untouched — the same
    // totals from different point values, rank 4 still vacant.
    for (const templateId of [
      'TPL-PUB-001', 'TPL-BOK-001', 'TPL-LTR-001',
      'TPL-LIT-001', 'TPL-LIT-002', 'TPL-LIT-003', 'TPL-LIT-004', 'TPL-LIT-005', 'TPL-LIT-006',
    ]) {
      const readout = await entityIntelligence(templateId, store);
      expect(readout?.trend.length, `${templateId} undensified points`).toBe(2);
    }
    const lit3 = await entityIntelligence('TPL-LIT-003', store);
    const lit4 = await entityIntelligence('TPL-LIT-004', store);
    expect(lit3?.cleared).toBe(92_000_000n);
    expect(lit4?.cleared).toBe(92_000_000n);
    expect(lit3?.cohort).toEqual({ rank: 3n, of: 9n });
    expect(lit4?.cohort).toEqual({ rank: 3n, of: 9n });
  });
});

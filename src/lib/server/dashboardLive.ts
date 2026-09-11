/**
 * The LIVE dashboard data source — the session-bound store reads behind the
 * DashboardDataProvider seam (the fixtures' promised successor; PR I).
 *
 * One aggregate builder, two doors:
 *
 *   GET /api/v1/dashboard  ─┐
 *                           ├─ loadSessionDashboard()
 *   /dashboard (page)      ─┤        │
 *   (workspace) layout ────┘        ├─ DON_DEV_SEED=1 → the dev-seed persona
 *                                   │   over the seeded in-memory store
 *                                   ├─ resolveSessionCreator() → the real
 *                                   │   session (JWT → profile → registry)
 *                                   │      → getStore() reads
 *                                   └─ the PAGE door only (page + layout,
 *                                       loadDashboardResolution): a
 *                                       SESSIONLESS resolution → the DEMO
 *                                       DOOR — the same seeded persona over
 *                                       a dedicated no-swap seeded store
 *                                       (getDemoDoorStore), rendered with
 *                                       its ONE DEMO DATA marker
 *
 * Everything the dashboard renders is read from the Don store for the
 * session's payee: the sovereign vault buckets, the holder-scoped GL
 * journals (each row carries the journal's entry_hash short form — the
 * auditability marker), and the payout holds attributed to their sandbox
 * rail via the BaaS transfers. Components consume the aggregate unchanged.
 *
 * Scale note: the canonical Store interface is locked (no per-payee GL list),
 * so the ledger window filters the store's full journal/entry lists
 * client-side — correct and bounded by RECENT_JOURNAL_LIMIT; a per-payee
 * store query is the follow-up if GL volume ever makes the scan felt.
 */

import {
  type DashboardData,
  type DashboardLedgerEntry,
  type DashboardPayout,
  type DashboardResolution,
  type DashboardViewResolution,
} from '@/lib/don/dashboardData';
import type { GlEntryRecord } from '@/modules/don/records';
import {
  DEV_SEED_CREATOR,
  getDemoDoorStore,
  getSeededStore,
  isDevSeedMode,
} from '@/lib/server/devSeed';
import { getStore, type Store } from '@/lib/server/store';
import {
  resolveSessionCreator,
  type SessionCreator,
} from '@/lib/server/sessionCreator';

/** The transactions card's window — "recent", bounded, newest first. */
export const RECENT_JOURNAL_LIMIT = 12;

/** The payout tiles' bound — the sandbox rail's live states, newest first. */
export const PAYOUT_TILE_LIMIT = 6;

/** The avatar chip's initials — word-initial letters, at most two. */
export function initialsFromName(stageName: string): string {
  const initials = stageName
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase())
    .slice(0, 2)
    .join('');
  return initials === '' ? '?' : initials;
}

function newestFirst(a: { created_at: string }, b: { created_at: string }): number {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

/**
 * The aggregate from the store for one creator — the pure store-read half of
 * the resolver (the InMemoryStore fixture exercises this directly in tests).
 * A missing vault is the honest zero state (no allocation has landed yet);
 * read ERRORS throw — fail closed, never a fabricated balance.
 */
export async function aggregateDashboardData(
  store: Store,
  creator: SessionCreator,
): Promise<DashboardData> {
  const payeeId = creator.payee_id;

  const [vault, journals, entries, transfers, taxProfile] = await Promise.all([
    store.getVault(payeeId),
    store.listGlJournals(),
    store.listGlEntries(),
    store.listBaasTransfers(),
    store.getCreatorTaxProfile(payeeId),
  ]);

  // Holder-scoped GL window: journals with at least one leg on this payee's
  // vault accounts, newest first, bounded to the recent window.
  const entriesByJournal = new Map<string, GlEntryRecord[]>();
  for (const entry of entries) {
    const legs = entriesByJournal.get(entry.journal_id);
    if (legs) {
      legs.push(entry);
    } else {
      entriesByJournal.set(entry.journal_id, [entry]);
    }
  }
  const vaultPrefix = `vault:${payeeId}:`;
  const ledger: DashboardLedgerEntry[] = journals
    .filter((journal) =>
      (entriesByJournal.get(journal.id) ?? []).some((entry) =>
        entry.account.startsWith(vaultPrefix),
      ),
    )
    .sort((a, b) => newestFirst(a, b) || b.sequence - a.sequence)
    .slice(0, RECENT_JOURNAL_LIMIT)
    .map((journal) => ({ journal, entries: entriesByJournal.get(journal.id) ?? [] }));

  // Payout states — the payee's BaaS transfers with their hold status; a
  // transfer without a hold never completed opening one (failed at creation)
  // and never renders as a tile.
  const payoutProjection = await Promise.all(
    transfers
      .filter((transfer) => transfer.payee_id === payeeId)
      .map(async (transfer): Promise<DashboardPayout | null> => {
        const hold = await store.getPayoutHold(transfer.id);
        return hold === null || hold === undefined
          ? null
          : { hold, rail: transfer.rail, provider: transfer.provider };
      }),
  );
  const payouts = payoutProjection
    .filter((payout): payout is DashboardPayout => payout !== null)
    .sort((a, b) => newestFirst(a.hold, b.hold))
    .slice(0, PAYOUT_TILE_LIMIT);

  return {
    user: { stage_name: creator.stage_name, initials: initialsFromName(creator.stage_name) },
    vault:
      vault ?? {
        payee_id: payeeId,
        payee_name: creator.stage_name,
        available_balance: 0,
        pending_balance: 0,
        reserve_balance: 0,
        updated_at: new Date().toISOString(),
      },
    ledger,
    payouts,
    readiness: {
      kyc_status: creator.kyc_status,
      tin_verified: taxProfile?.tin_verified ?? 0,
      w9_on_file: taxProfile?.w9_on_file ?? 0,
      bank_account_linked: creator.bank_account_linked,
      provisioning_status: creator.provisioning_status,
    },
  };
}

/**
 * The session-bound dashboard resolution — the ONE function both the page
 * and the API route resolve through. Read failures propagate (the route maps
 * them to named 502 codes; the page renders its error state).
 */
export async function loadSessionDashboard(): Promise<DashboardResolution> {
  // The dev-seed mode: the demo persona over the seeded in-memory store —
  // the e2e/preview door, reachable only with DON_DEV_SEED=1.
  if (isDevSeedMode()) {
    return {
      kind: 'registered',
      data: await aggregateDashboardData(await getSeededStore(), DEV_SEED_CREATOR),
    };
  }

  const resolution = await resolveSessionCreator();
  if (resolution.kind !== 'registered') {
    return resolution;
  }
  return {
    kind: 'registered',
    data: await aggregateDashboardData(getStore(), resolution.creator),
  };
}

/**
 * The seeded demo resolution — PR #54's seeded persona over a seeded store,
 * resolved to the `demo` kind: the page renders its ONE DEMO DATA marker on
 * it (and only on it), so no seeded balance can present as a real holder's.
 */
async function seededDemoResolution(store: Promise<Store>): Promise<DashboardViewResolution> {
  return {
    kind: 'demo',
    data: await aggregateDashboardData(await store, DEV_SEED_CREATOR),
  };
}

/**
 * The PAGE-facing resolution — the door the /dashboard page and the
 * (workspace) layout render through. The SAME seeded mechanism as the API
 * door, with ONE difference: a sessionless visitor lands on the DEMO DOOR
 * instead of the anonymous wall.
 *
 * The demo door is VERCEL_ENV-agnostic (the standing directive: the main
 * site opens straight onto the populated dashboard — zero user actions, no
 * /signin redirect, no NO SESSION wall). It is fail-closed BY SHAPE: this
 * branch fires only when the session resolution came back `anonymous` —
 * there is no session, so there is no real identity and no real user's data
 * to leak; the rendered persona is the hardcoded seeded demo over a store
 * that never replaces the persistence seam (getDemoDoorStore).
 */
export async function loadDashboardResolution(): Promise<DashboardViewResolution> {
  // Dev-seed mode (DON_DEV_SEED=1 / preview): every render IS the seeded
  // demo view — the shared booted store, marked demo.
  if (isDevSeedMode()) {
    return seededDemoResolution(getSeededStore());
  }

  const resolution = await resolveSessionCreator();
  if (resolution.kind === 'anonymous') {
    // THE DEMO DOOR — production's signed-out visitors included.
    return seededDemoResolution(getDemoDoorStore());
  }
  if (resolution.kind !== 'registered') {
    return resolution;
  }
  return {
    kind: 'registered',
    data: await aggregateDashboardData(getStore(), resolution.creator),
  };
}

/** The dashboard's provider — the page-facing door (the demo door included). */
export const liveDashboardDataProvider = {
  getDashboardResolution: loadDashboardResolution,
};

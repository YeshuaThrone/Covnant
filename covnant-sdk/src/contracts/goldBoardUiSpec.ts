/**
 * GOLD BOARD UI SPEC — the strip composition contract (D-directive,
 * spec art_9tCxOhGO).
 *
 * The Gold Board is the money-first home: balance overview + revenue
 * streams, payouts, transactions, readiness. QUICK ACTIONS ARE REMOVED —
 * the strip is read-only financial truth, not a launcher. The ADMIN
 * pill lives in the page-header slot (never creator navigation).
 */

/** The strip's exact section order — one composition, no variants. */
export const GOLD_BOARD_SECTIONS = [
  'balance_overview',
  'revenue_streams',
  'payouts',
  'transactions',
  'readiness',
] as const;

export type GoldBoardSection = (typeof GOLD_BOARD_SECTIONS)[number];

/**
 * The dashboard's ADMIN pill — the page-header slot's gated console link.
 * In the workspace NAV ARRAY it must NOT appear (the five-tab trim is
 * locked); the header slot renders it as a link to the existing,
 * fail-closed /admin console.
 */
export const ADMIN_CONSOLE_ROUTE = '/admin';

/** The header slot's navigation labels — the five creator tabs, in order. */
export const CREATOR_NAV_LABELS = [
  'Gold Board',
  'Covnant ID',
  'Virtual Card',
  'Sync License',
  'Settings',
] as const;

/**
 * One revenue stream — a holder's royalty inflow grouped by source,
 * aggregated from the holder-scoped GL (royalty-ingest journals' vault
 * legs), newest activity first. Store-read only: a stream row that cannot
 * be derived from the ledger does not render.
 */
export interface GoldBoardRevenueStream {
  source: string;
  /** Σ of the holder's vault credit legs on that source's royalty ingests. */
  total_cents: number;
}

/** Maximum streams rendered in the strip (the bounded slice). */
export const REVENUE_STREAM_LIMIT = 4;

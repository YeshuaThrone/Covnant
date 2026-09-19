/**
 * Client-safe admin overview folds — pure transforms with no server-side
 * imports, so client components (the admin console sections) can use them
 * without dragging the ledger/SDK module graph (node:crypto) into the
 * browser bundle. The server aggregation module re-exports these so API
 * routes and tests keep one canonical import path.
 */

import type { AdminAllowlistRow } from './allowlists';

export interface AllowlistsSummary {
  total: number;
  byStatus: { ACTIVE: number; REVOKED: number };
}

export function allowlistsSummary(rows: AdminAllowlistRow[]): AllowlistsSummary {
  const byStatus: AllowlistsSummary['byStatus'] = { ACTIVE: 0, REVOKED: 0 };
  for (const row of rows) byStatus[row.status] += 1;
  return { total: rows.length, byStatus };
}

/**
 * Admin console view contracts — the props the /admin page (server)
 * hands to the console components (client). SectionData is an honest
 * union: a section either carries its real rows or carries the sanitized
 * failure (code + message) explaining why it cannot — never an empty lie.
 */

import type { AdminAllowlistRow } from '@/lib/admin/allowlists';
import type { AdminCreatorProfile } from '@/lib/admin/types';
import type { LedgerSummary, RegistrySummary } from '@/lib/admin/overview';
import type { SovereignLedgerRecord, SovereignLedgerSummary } from '@/lib/master/sovereignLedger';

export type SectionData<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'unavailable'; code: string; message: string };

/** One read-only contract row — the console shows the record, not the document. */
export interface ContractRow {
  id: string;
  cbtCode: string;
  templateId: string;
  industry: string;
  status: 'DRAFT' | 'FINAL';
  createdAt: string;
  updatedAt: string;
}

/**
 * The master ledger section payload (founder canon, CovnantMasterDataSDK):
 * the six-vertical sovereign records with their engine-computed 50/35/15
 * allocations. `demo` drives the DEMO DATA disclosure — the seeded library
 * renders only behind it; real sessions carry real settled rows.
 */
export interface MasterLedgerSection {
  demo: boolean;
  summary: SovereignLedgerSummary;
  records: SovereignLedgerRecord[];
}

export interface AdminConsoleData {
  registry: RegistrySummary;
  ledger: LedgerSummary;
  contracts: SectionData<ContractRow[]>;
  creators: SectionData<AdminCreatorProfile[]>;
  allowlists: SectionData<AdminAllowlistRow[]>;
  master: SectionData<MasterLedgerSection>;
}

/** The six console tabs, in operator order. */
export const CONSOLE_TABS = [
  'Overview',
  'Creators',
  'UCT Registry',
  'Ledger',
  'Contracts',
  'Allowlists',
] as const;

export type ConsoleTab = (typeof CONSOLE_TABS)[number];

/**
 * Admin console view contracts — the props the /admin page (server)
 * hands to the console components (client). SectionData is an honest
 * union: a section either carries its real rows or carries the sanitized
 * failure (code + message) explaining why it cannot — never an empty lie.
 */

import type { AdminAllowlistRow } from '@/lib/admin/allowlists';
import type { AdminCreatorProfile } from '@/lib/admin/types';
import type { LedgerSummary, RegistrySummary } from '@/lib/admin/overview';

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

export interface AdminConsoleData {
  registry: RegistrySummary;
  ledger: LedgerSummary;
  contracts: SectionData<ContractRow[]>;
  creators: SectionData<AdminCreatorProfile[]>;
  allowlists: SectionData<AdminAllowlistRow[]>;
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

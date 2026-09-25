/**
 * Admin console view contracts — the props the /admin page (server)
 * hands to the console components (client). SectionData is an honest
 * union: a section either carries its real rows or carries the sanitized
 * failure (code + message) explaining why it cannot — never an empty lie.
 */

import type { AdminAllowlistRow } from '@/lib/admin/allowlists';
import type { OperationsFlows } from '@/lib/admin/operations';
import type { AdminCreatorProfile } from '@/lib/admin/types';
import type { AnalyticsWindow, CompanyAnalytics } from '@/lib/admin/companyAnalytics';
import type { CreatorAnalyticsFlows } from '@/lib/admin/creatorAnalytics';
import type { CatalogGrowthFlows } from '@/lib/admin/catalogGrowth';
import type { EntityIntelligence } from '@/lib/admin/entityIntelligence';
import type { LedgerSummary, RegistrySummary } from '@/lib/admin/overview';
import type { ControlBoardState } from '@/lib/master/controlBoard';
import type { SovereignLedgerRecord, SovereignLedgerSummary } from '@/lib/master/sovereignLedger';
import type { SettlementRowView } from '@/lib/ledger/finances';
import type { GoldBoardRevenueStream } from '../../../covnant-sdk/src/contracts/goldBoardUiSpec';
import type {
  TaxAnnualRowView,
  TaxCurrencyRowView,
  TaxPayeeRowView,
  TaxPeriodRowView,
  TaxTransactionRowView,
} from '@/lib/tax/withholding';

export type {
  TaxAnnualRowView,
  TaxCurrencyRowView,
  TaxPayeeRowView,
  TaxPeriodRowView,
  TaxTransactionRowView,
} from '@/lib/tax/withholding';

export type SectionData<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'unavailable'; code: string; message: string };

/**
 * The Analytics tab's company payload — the derivation module's read for
 * EVERY registered window (7d / 30d / 90d / all), each derived server-side
 * by `companyAnalytics` over the same store door as its siblings. The
 * section's window filter is a client-side pick over these pre-derived
 * windows: the whole page is one prop-driven read of one safe payload per
 * window, and the filter never re-fetches — every window the page can show
 * was already derived from the store before first paint.
 */
export type CompanyAnalyticsWindows = Record<AnalyticsWindow, CompanyAnalytics>;

/**
 * The Creator Analytics tab's window-filter id — the page's pre-derived
 * creator windows. The derivation module's own `CreatorWindowDays` (7 / 30
 * / 90, `null` for ALL) rides inside each payload and lights the filter.
 */
export type CreatorAnalyticsWindowId = '7d' | '30d' | '90d' | 'all';

/**
 * The Creator Analytics tab's payload (spec art_UccVWZpj) — the creator-side
 * derivation's read for EVERY registered window, each derived server-side by
 * `creatorAnalytics` over the same store door as its siblings. The section's
 * window filter is a client-side pick over these pre-derived windows: the
 * whole tab is one prop-driven read of one safe payload per window, and the
 * filter never re-fetches — every window the page can show was already
 * derived from the store before first paint.
 */
export type CreatorAnalyticsWindows = Record<CreatorAnalyticsWindowId, CreatorAnalyticsFlows>;

/**
 * The Creator Analytics tab's Catalog Growth OS layer (spec art_qNu4T32F) —
 * the catalog-growth derivation's read for EVERY registered window, derived
 * server-side by `catalogGrowthFlows` over the same store door as its
 * siblings. The section's window filter picks among these pre-derived
 * payloads exactly as it does the creator windows; the recoupment and Top
 * Markets folds are standing (unwindowed), the signals are per-window.
 */
export type CatalogGrowthWindows = Record<CreatorAnalyticsWindowId, CatalogGrowthFlows>;

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
 * the seven-vertical sovereign records with their engine-computed 50/35/15
 * allocations. `demo` drives the DEMO DATA disclosure — the seeded library
 * renders only behind it; real sessions carry real settled rows.
 */
export interface MasterLedgerSection {
  demo: boolean;
  summary: SovereignLedgerSummary;
  records: SovereignLedgerRecord[];
}

/**
 * The Ledger section's FINANCES payload (founder directive, 2026-09-20):
 * the settlement rows exactly as the /ledger page renders them — engine
 * output through the shared selector layer, never copied strings. Escrow
 * and payout state fold from the same rows on the client.
 */
export interface LedgerFinancesSection {
  demo: boolean;
  rows: SettlementRowView[];
}

/** One CBT-stamped contract execution — the master clearing ledger's lane landing. */
export interface ExecutionStampRow {
  executionId: string;
  stampedAt: string;
  ledgerId: string;
  assetTitle: string;
  /** Canonical CBT when the asset is known (null when the record predates the join). */
  cbt: string | null;
  /** Derived from the canonical CBT (null when the record predates derivation). */
  cvt: string | null;
  templateId: string | null;
  /** The lane's vertical sector label, when the record carries one. */
  sector: string | null;
}

/** One master template binding — the registry's template layer, never money. */
export interface TemplateBindingRow {
  templateId: string;
  templateName: string;
  /** The template's subCategory — the sector of record ('Master Recording', 'Audiobook Publishing'). */
  sector: string;
  verticalCategory: string;
  executionStatus: string;
  timesExecuted: number;
  /** The bound atomic entity class pill (MUSIC, FILM, ...), when one binds. */
  entityClassTag: string | null;
  /** Lane telemetry execution state — CLEARED or HELD_IN_ESCROW. */
  executionState: string | null;
}

/**
 * The Contracts section's REGISTRY payload (founder directive, 2026-09-20):
 * CBT-stamped executions, template bindings, and lineage — distinct from
 * the money view, which lives on the Ledger tab.
 */
export interface ContractRegistrySection {
  demo: boolean;
  executions: ExecutionStampRow[];
  templates: TemplateBindingRow[];
}

/**
 * The Tax section's payload (founder directive, 2026-09-21: the tax agent's
 * data sheet). Two honest layers — the ledger layer (exact minor-unit sums
 * from the Don settlement engine) and the tax layer (every payee payout
 * resolved through CovnantTaxEngineSDK, the tax engine of record) — plus
 * the per-currency rollup and the non-USD disclosure. The per-payee annual
 * block mirrors the CSV export's first block; the register covers EVERY
 * creator with cleared history, never a curated subset.
 */
export interface TaxSectionData {
  demo: boolean;
  payees: TaxPayeeRowView[];
  periods: TaxPeriodRowView[];
  annual: TaxAnnualRowView[];
  transactions: TaxTransactionRowView[];
  currencies: TaxCurrencyRowView[];
  /** Settled rows outside the USD tax engine, disclosed instead of dropped. */
  excludedNonUsdSettlements: number;
}

export interface AdminConsoleData {
  registry: RegistrySummary;
  ledger: LedgerSummary;
  contracts: SectionData<ContractRow[]>;
  creators: SectionData<AdminCreatorProfile[]>;
  /** True exactly when the demo door is open — gates the Creators tab's disclosed demo cards. */
  creatorsDemo: boolean;
  allowlists: SectionData<AdminAllowlistRow[]>;
  master: SectionData<MasterLedgerSection>;
  /** The Ledger tab's finances surface — settlements one-truth with /ledger. */
  finances: LedgerFinancesSection;
  /** The Contracts tab's registry surface — executions + template bindings. */
  contractRegistry: ContractRegistrySection;
  /** The Tax tab — withholding register, period summaries, transaction register, CSV export. */
  tax: TaxSectionData;
  /**
   * The Covnant Control Board's server-bound state — the same entity-bound
   * board the /templates page SSRs, composed from the same master-store
   * engine so the console section renders the identical library.
   */
  controlBoard: ControlBoardState;
  /**
   * The Overview tab's Revenue Streams strip (founder directive 2026-09-22:
   * moved off the Gold Board, rendered under Smart Ledger Verification) —
   * platform-wide royalty inflow by source, store-read only.
   */
  revenueStreams: SectionData<GoldBoardRevenueStream[]>;
  /**
   * The Analytics tab's payload — the Elite Dashboard company page (spec
   * art_rRYEJBpS): `companyAnalytics` over the same Don store door as the
   * Revenue Streams and Intelligence reads, derived for every window
   * (7d / 30d / 90d / all) so the page's window filter re-renders from
   * store-derived payloads without a refetch. Store-read only.
   */
  analytics: SectionData<CompanyAnalyticsWindows>;
  /** True exactly when the demo door is open — gates the Analytics tab's disclosed demo badge. */
  analyticsDemo: boolean;
  /**
   * The Intelligence tab's payload (2026-09-22 founder directive): every
   * registered atomic entity's four-read intelligence readout over the
   * same Don store door as the Analytics read — store-read only, one
   * honest union for the whole roster.
   */
  intelligence: SectionData<readonly EntityIntelligence[]>;
  /** True exactly when the demo door is open — gates the Intelligence tab's disclosed demo badge. */
  intelligenceDemo: boolean;
  /**
   * The Creator Analytics tab's payload (spec art_UccVWZpj): the creator-side
   * derivation over the same Don store door as the Analytics and Intelligence
   * reads, derived for every window (7d / 30d / 90d / all) so the tab's
   * window filter re-renders from store-derived payloads without a refetch.
   * Store-read only.
   */
  creatorAnalytics: SectionData<CreatorAnalyticsWindows>;
  /** True exactly when the demo door is open — gates the Creator Analytics tab's disclosed demo badge. */
  creatorAnalyticsDemo: boolean;
  /**
   * The Creator Analytics tab's Catalog Growth OS layer (spec art_qNu4T32F):
   * the catalog-growth derivation over the same Don store door — the
   * recoupment-by-catalog engine state, the Top Markets territory fold,
   * and the per-window action signals — one safe payload per window.
   * Store-read only.
   */
  catalogGrowth: SectionData<CatalogGrowthWindows>;
  /**
   * The Operations tab's payload (spec art_Eis55ifL): the back-office
   * derivation's five views over the Don store door — escrow &
   * settlements, runs & pipeline health, the verification-exception
   * queue, the payee/creator registry, and the operator audit log — one
   * safe payload, honest empty states throughout. Store-read only.
   */
  operations: SectionData<OperationsFlows>;
  /** True exactly when the demo door is open — gates the Operations tab's disclosed demo badge. */
  operationsDemo: boolean;
}

/** The twelve console tabs, in operator order. */
export const CONSOLE_TABS = [
  'Overview',
  'Creators',
  'UCT Registry',
  'Ledger',
  'Contracts',
  'Tax',
  'Control Board',
  'Analytics',
  'Intelligence',
  'Creator Analytics',
  'Allowlists',
  'Operations',
] as const;

export type ConsoleTab = (typeof CONSOLE_TABS)[number];

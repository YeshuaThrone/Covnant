/**
 * Contract template catalog — PR 3 (fourteen deterministic templates).
 *
 * Spec §Contract vault: templates live in two industries, ten music and four
 * film/media/merch. Each template assembles named clauses in order. The vault
 * replaces the former AI surface — generation is pure template hydration from
 * registered asset data, nothing more.
 */

export type ContractIndustry = 'MUSIC' | 'FILM_MEDIA_MERCH';

export const INDUSTRY_LABELS: Record<ContractIndustry, string> = {
  MUSIC: 'Music',
  FILM_MEDIA_MERCH: 'Film, Media & Merch',
};

export interface ContractTemplate {
  /** Stable machine id, e.g. 'MUSIC_SPLIT_SHEET' | 'FILM_SCREENPLAY_OPTION'. */
  id: string;
  industry: ContractIndustry;
  name: string;
  /** Named clauses the template assembles, in document order. */
  clauseOrder: string[];
  /** One-line summary shown on the vault card. */
  summary: string;
}

export const TEMPLATES: readonly ContractTemplate[] = [
  // ── Music (10) ────────────────────────────────────────────────────────────
  {
    id: 'MUSIC_SPLIT_SHEET',
    industry: 'MUSIC',
    name: 'Split Sheet',
    clauseOrder: ['preamble', 'workIdentified', 'poolSheets', 'control', 'signatures'],
    summary: 'Authoritative ownership percentages across all three Covenant pools.',
  },
  {
    id: 'MUSIC_PRODUCER_AGREEMENT',
    industry: 'MUSIC',
    name: 'Producer Agreement',
    clauseOrder: ['parties', 'engagement', 'deliverables', 'compensation', 'credit', 'masterOwnership', 'signatures'],
    summary: 'Engages a producer on a master with ownership and credit terms.',
  },
  {
    id: 'MUSIC_FEATURE_ARTIST',
    industry: 'MUSIC',
    name: 'Feature Artist Agreement',
    clauseOrder: ['parties', 'engagement', 'contribution', 'compensation', 'credit', 'signatures'],
    summary: 'Books a featured performance with compensation and billing.',
  },
  {
    id: 'MUSIC_BEAT_LICENSE',
    industry: 'MUSIC',
    name: 'Beat License',
    clauseOrder: ['parties', 'licensedWork', 'scope', 'territory', 'term', 'fee', 'restrictions', 'signatures'],
    summary: 'Licenses an instrumental beat with scope, territory, and term.',
  },
  {
    id: 'MUSIC_WORK_FOR_HIRE',
    industry: 'MUSIC',
    name: 'Work For Hire Agreement',
    clauseOrder: ['parties', 'engagement', 'workMadeForHire', 'compensation', 'ownership', 'waiver', 'signatures'],
    summary: 'Commissions a contribution as a work made for hire.',
  },
  {
    id: 'MUSIC_PUBLISHING_SPLIT',
    industry: 'MUSIC',
    name: 'Publishing Split Agreement',
    clauseOrder: ['parties', 'composition', 'writerShares', 'administration', 'collections', 'signatures'],
    summary: 'Fixes writer and publisher shares of the composition copyright.',
  },
  {
    id: 'MUSIC_SYNC_LICENSE',
    industry: 'MUSIC',
    name: 'Sync License',
    clauseOrder: ['parties', 'licensedWork', 'use', 'territory', 'term', 'fee', 'credit', 'signatures'],
    summary: 'Grants an audiovisual synchronization use of the work.',
  },
  {
    id: 'MUSIC_MANAGEMENT',
    industry: 'MUSIC',
    name: 'Management Agreement',
    clauseOrder: ['parties', 'engagement', 'term', 'commission', 'expenses', 'termination', 'signatures'],
    summary: 'Retains a manager with commission and termination terms.',
  },
  {
    id: 'MUSIC_MASTER_PURCHASE',
    industry: 'MUSIC',
    name: 'Master Purchase Agreement',
    clauseOrder: ['parties', 'masters', 'purchasePrice', 'delivery', 'warranties', 'signatures'],
    summary: 'Transfers ownership of masters for a fixed purchase price.',
  },
  {
    id: 'MUSIC_REMIX_CLEARANCE',
    industry: 'MUSIC',
    name: 'Remix Clearance',
    clauseOrder: ['parties', 'originalWork', 'remixScope', 'clearance', 'credit', 'compensation', 'signatures'],
    summary: 'Clears a remix against the original work with credit terms.',
  },
  // ── Film / Media & Merch (4) ──────────────────────────────────────────────
  {
    id: 'FILM_SCREENPLAY_OPTION',
    industry: 'FILM_MEDIA_MERCH',
    name: 'Screenplay Option Agreement',
    clauseOrder: ['parties', 'property', 'optionGrant', 'term', 'optionFee', 'purchasePrice', 'credit', 'signatures'],
    summary: 'Options a screenplay with fee, term, and purchase price.',
  },
  {
    id: 'FILM_TALENT_RELEASE',
    industry: 'FILM_MEDIA_MERCH',
    name: 'Talent Release',
    clauseOrder: ['parties', 'production', 'releaseGrant', 'consideration', 'publicity', 'signatures'],
    summary: 'Releases an on-screen performance for production and publicity use.',
  },
  {
    id: 'FILM_FINE_ART_CONSIGNMENT',
    industry: 'FILM_MEDIA_MERCH',
    name: 'Fine Art Consignment Agreement',
    clauseOrder: ['parties', 'artwork', 'consignmentTerm', 'commission', 'insurance', 'settlement', 'signatures'],
    summary: 'Consigns artwork for sale with commission and insurance terms.',
  },
  {
    id: 'FILM_BRAND_ENDORSEMENT',
    industry: 'FILM_MEDIA_MERCH',
    name: 'Brand Endorsement Agreement',
    clauseOrder: ['parties', 'campaign', 'scope', 'term', 'compensation', 'usage', 'signatures'],
    summary: 'Engages a creator to endorse a brand campaign.',
  },
] as const;

export function getTemplate(id: string): ContractTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function templatesByIndustry(industry: ContractIndustry): readonly ContractTemplate[] {
  return TEMPLATES.filter((t) => t.industry === industry);
}

/** Clause display labels shared across templates; renderers live in generator.ts. */
export const CLAUSE_LABELS: Record<string, string> = {
  preamble: 'Preamble',
  workIdentified: 'Work Identified',
  poolSheets: 'Pool Split Sheets',
  control: 'Control & Direction',
  parties: 'Parties',
  engagement: 'Engagement',
  deliverables: 'Deliverables',
  compensation: 'Compensation',
  credit: 'Credit',
  masterOwnership: 'Ownership of Masters',
  contribution: 'Contribution',
  licensedWork: 'Licensed Work',
  scope: 'Scope of License',
  territory: 'Territory',
  term: 'Term',
  fee: 'Fee',
  restrictions: 'Restrictions',
  workMadeForHire: 'Work Made For Hire',
  ownership: 'Ownership',
  waiver: 'Waiver of Rights',
  composition: 'Composition',
  writerShares: 'Writer & Publisher Shares',
  administration: 'Administration',
  collections: 'Collections',
  use: 'Use',
  masters: 'Masters Purchased',
  purchasePrice: 'Purchase Price',
  delivery: 'Delivery',
  warranties: 'Warranties',
  originalWork: 'Original Work',
  remixScope: 'Remix Scope',
  clearance: 'Clearance',
  property: 'Property',
  optionGrant: 'Option Grant',
  optionFee: 'Option Fee',
  production: 'Production',
  releaseGrant: 'Release Grant',
  consideration: 'Consideration',
  publicity: 'Publicity',
  artwork: 'Artwork',
  consignmentTerm: 'Consignment Term',
  commission: 'Commission',
  insurance: 'Insurance',
  settlement: 'Settlement',
  campaign: 'Campaign',
  usage: 'Usage Rights',
  expenses: 'Expenses',
  termination: 'Termination',
  signatures: 'Signatures',
};

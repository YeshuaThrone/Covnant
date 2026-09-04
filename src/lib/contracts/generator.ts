/**
 * Deterministic agreement generator — spec §Contract vault.
 *
 * `generateAgreement(template, ctx)` hydrates a ContractTemplate's clauses from
 * an AgreementContext assembled from the registered asset (via getOrHydrateAsset
 * → poolsFromSheet) — asset identifiers, party names, roles, and each pool's
 * exact percentages. The generator is pure: identical inputs yield identical
 * documents, nothing is fetched from external services, and no wall-clock
 * timestamps enter the rendered text.
 */

import type { CovenantBlockAsset } from '@/engine/covenant-master-sdk';
import { cvtDisplayCode } from '@/lib/splits/codes';
import { poolsFromSheet } from '@/lib/splits/multi-pool';
import {
  formatUnitsAsPercent,
  MEDIUM_LABELS,
  POOL_LABELS,
  type PoolName,
} from '@/lib/splits/shared';
import type { ContractTemplate } from './templates';
import { CLAUSE_LABELS } from './templates';

// ── Context ────────────────────────────────────────────────────────────────

export interface AgreementIdentifier {
  label: string;
  value: string;
}

export interface AgreementParty {
  name: string;
  role: string;
  pools: string;
  /** Exact per-pool share (4-decimal percent string) where the pool defines one. */
  sharePercent?: string;
  isni?: string;
  ipi?: string;
}

export interface AgreementPool {
  pool: PoolName;
  label: string;
  /** Pool total at 4-decimal precision, e.g. "100.0000". */
  totalPercent: string;
  holders: AgreementParty[];
}

export interface AgreementFields {
  effectiveDate: string;
  territory: string;
  term: string;
  fee: string;
  governingLaw: string;
}

export interface AgreementContext {
  asset: {
    title: string;
    mediumLabel: string;
    cbtCode: string;
    displayCode: string;
    identifiers: AgreementIdentifier[];
  };
  pools: AgreementPool[];
  parties: AgreementParty[];
  fields: AgreementFields;
}

export const DEFAULT_FIELDS: AgreementFields = {
  effectiveDate: '',
  territory: 'Worldwide',
  term: 'Twelve (12) months from the Effective Date',
  fee: 'As separately agreed in writing between the Parties',
  governingLaw: 'the State of Delaware, United States',
};

/**
 * Assembles the AgreementContext from the stored asset of record. The pools
 * are read through the same multi-pool adapter the studio saves with, so a
 * generated Split Sheet agrees with the stored pools share-for-share by
 * construction.
 */
export function hydrateContext(
  asset: CovenantBlockAsset,
  overrides: Partial<AgreementFields> = {},
): AgreementContext {
  const pools: AgreementPool[] = poolsFromSheet(asset).map((pool) => ({
    pool: pool.pool,
    label: POOL_LABELS[pool.pool],
    totalPercent: formatUnitsAsPercent(
      pool.holders.reduce((sum, h) => sum + h.splitPercentage, 0),
    ),
    holders: pool.holders.map((h) => ({
      name: h.name,
      role: h.role,
      pools: POOL_LABELS[pool.pool],
      sharePercent: formatUnitsAsPercent(h.splitPercentage),
      isni: h.isni,
      ipi: h.ipi,
    })),
  }));

  const byKey = new Map<string, AgreementParty>();
  for (const pool of pools) {
    for (const holder of pool.holders) {
      const key = `${holder.name}::${holder.role}`;
      const existing = byKey.get(key);
      if (existing) {
        if (existing.sharePercent !== holder.sharePercent) {
          existing.sharePercent = undefined;
        }
        existing.pools = mergePools(existing.pools, pool.label);
        continue;
      }
      byKey.set(key, { ...holder });
    }
  }

  const identifiers: AgreementIdentifier[] = Object.entries(asset.mappedIdentifiers)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([key, value]) => ({ label: key.toUpperCase(), value }));

  return {
    asset: {
      title: asset.title,
      mediumLabel: MEDIUM_LABELS[asset.medium],
      cbtCode: asset.cbtCode,
      displayCode: cvtDisplayCode(asset.cbtCode),
      identifiers,
    },
    pools,
    parties: [...byKey.values()],
    fields: { ...DEFAULT_FIELDS, ...overrides },
  };
}

function mergePools(current: string, next: string): string {
  const labels = current.split(' · ');
  return labels.includes(next) ? current : [...labels, next].join(' · ');
}

// ── Clause renderers ───────────────────────────────────────────────────────

export interface GeneratedAgreement {
  templateId: string;
  fields: AgreementContext;
  document: string;
}

const effectiveDate = (fields: AgreementFields): string =>
  fields.effectiveDate.trim().length > 0 ? fields.effectiveDate.trim() : 'the date of last signature';

const partiesLine = (ctx: AgreementContext): string =>
  ctx.parties.map((p) => `${p.name} (${p.role})`).join(', ');

function partyTable(ctx: AgreementContext): string {
  return ctx.parties
    .map((p, i) => {
      const codes = [p.isni ? `ISNI ${p.isni}` : undefined, p.ipi ? `IPI ${p.ipi}` : undefined]
        .filter(Boolean)
        .join(' · ');
      return `  ${i + 1}. ${p.name} — ${p.role} · ${p.pools}${p.sharePercent ? ` · ${p.sharePercent}%` : ''}${codes ? ` · ${codes}` : ''}`;
    })
    .join('\n');
}

function poolSheetBody(ctx: AgreementContext): string {
  return ctx.pools
    .map((pool) => {
      const lines = pool.holders
        .map((h, i) => `      ${String.fromCharCode(97 + i)}. ${h.name} (${h.role}) — ${h.sharePercent}%`)
        .join('\n');
      return `    ${pool.label} — total ${pool.totalPercent}%\n${lines.length > 0 ? lines : '      (no holders recorded)'}`;
    })
    .join('\n');
}

function signatureBody(ctx: AgreementContext): string {
  const blocks = ctx.parties
    .map((p) => `  ${p.name} (${p.role})\n  Signature: ______________________   Date: ____________`)
    .join('\n\n');
  return `IN WITNESS WHEREOF, the Parties have executed this agreement as of ${effectiveDate(ctx.fields)}.\n\n${blocks}`;
}

function clauseBody(clause: string, template: ContractTemplate, ctx: AgreementContext): string {
  const { asset, fields } = ctx;
  const parties = partiesLine(ctx);
  const work = `"${asset.title}" (${asset.mediumLabel})`;
  const law = fields.governingLaw;

  switch (clause) {
    case 'preamble':
      return `This ${template.name} (the "Agreement") is entered into as of ${effectiveDate(fields)} by and between ${parties}, in connection with the work ${work}, identified by Covenant Block code ${asset.cbtCode} (display code ${asset.displayCode}).`;
    case 'workIdentified':
      return `The Work is ${work}, registered in the Covenant registry under CBT code ${asset.cbtCode} (display code ${asset.displayCode}).${asset.identifiers.length > 0 ? ` Registered identifiers: ${asset.identifiers.map((i) => `${i.label} ${i.value}`).join(' · ')}.` : ''}`;
    case 'poolSheets':
      return `Ownership of the Work is recorded in the Covenant pools exactly as stored on the asset of record. Each pool's shares are authoritative and sum to 100.0000%:\n${poolSheetBody(ctx)}`;
    case 'control':
      return `Direction and control of the Work follow the Master Recording pool's recorded ownership. No Party may license or transfer rights in the Work except in accordance with these recorded percentages. The Parties adopt the recorded split sheet as the authoritative statement of ownership, superseding any conflicting prior understanding.`;
    case 'parties':
      return `The Parties to this Agreement are:\n${partyTable(ctx)}`;
    case 'engagement':
      return `Each Party engages and is engaged in connection with ${work} on the terms of this Agreement. The engagement begins on ${effectiveDate(fields)} and continues for the Term set out below.`;
    case 'deliverables':
      return `The delivering Party shall furnish all materials, stems, masters, and documentation reasonably required for the exploitation of ${work}, delivered in the formats customarily used in the industry and accepted by the receiving Party.`;
    case 'compensation':
      return `Compensation for the engagement is ${fields.fee}. Where the Work's Covenant pools record a share for a Party, that Party is additionally entitled to its exact recorded percentage of net receipts attributable to the Work.`;
    case 'credit':
      return `Credit shall be rendered in substantially the form recorded for each Party in the Covenant registry (name and role), in a manner customary for works of the same type. No Party may unilaterally alter another Party's approved credit.`;
    case 'masterOwnership':
      return `Ownership of the masters embodying the Work vests in the holders recorded in the Covenant pools at their exact recorded percentages. The recorded split sheet is the authoritative ownership record and controls over any conflicting writing.`;
    case 'contribution':
      return `The contributing Party's performance, composition, or other creative contribution to ${work} is recorded in the Covenant pools and is compensated as set out below.`;
    case 'licensedWork':
      return `The licensor grants the license with respect to ${work}, identified by CBT code ${asset.cbtCode} (display code ${asset.displayCode}), including the registered identifiers${asset.identifiers.length > 0 ? ` (${asset.identifiers.map((i) => `${i.label} ${i.value}`).join(', ')})` : ''}.`;
    case 'scope':
      return `The license is granted for the uses expressly agreed in writing between the Parties and recorded in the Covenant ledger at settlement time. All uses outside the agreed scope require separate written consent.`;
    case 'use':
      return `The composition may be synchronized and reproduced solely in the production and exploitation of the audiovisual work the Parties have agreed in writing; no other use is licensed under this Agreement.`;
    case 'territory':
      return `This Agreement applies in the following territory: ${fields.territory}.`;
    case 'term':
      return `The term of this Agreement is: ${fields.term}. Upon expiration, all rights not expressly renewed revert to the owners recorded in the Covenant pools.`;
    case 'fee':
      return `The fee for the rights granted is ${fields.fee}. Fees are payable through the Covenant settlement pipeline so that each Party's exact recorded share is disbursed and the embedded auditor can reconcile every distribution against the split sheet.`;
    case 'restrictions':
      return `The licensee shall not alter, sample, or sublicense the Work beyond the agreed scope, shall not register the Work or any part of it with any collection society, and shall not obscure or replace the credits of the owners recorded in the Covenant pools.`;
    case 'workMadeForHire':
      return `The Parties intend that the contribution to ${work} constitute a "work made for hire" for the commissioning Party to the fullest extent permitted by law.`;
    case 'ownership':
      return `All rights, title, and interest in the results of the engagement vest as recorded in the Covenant pools and this Agreement, without further consideration beyond the compensation stated herein.`;
    case 'waiver':
      return `To the extent any contribution is determined not to be a work made for hire, the contributing Party irrevocably assigns all such rights to the commissioning Party and waives any moral rights to the extent permitted by law.`;
    case 'composition':
      return `This Agreement concerns the composition ${work}, identified by CBT code ${asset.cbtCode} (display code ${asset.displayCode}).`;
    case 'writerShares':
      return `Writer and publisher shares of the composition are those recorded in the Writer/Composition and Publisher Administration pools of the Covenant registry, which sum to exactly 100.0000% each and are authoritative:\n${poolSheetBody(ctx)}`;
    case 'administration':
      return `Administration of the composition follows the recorded Publisher Administration pool. The administrator collects and disburses receipts through the Covenant settlement pipeline at each Party's exact recorded percentage.`;
    case 'collections':
      return `All receipts attributable to the Work are collected and disbursed at the exact recorded percentages; the Covenant auditor reconciles every distribution against the split sheet before it posts.`;
    case 'masters':
      return `The seller sells and the buyer purchases all of the seller's right, title, and interest in and to the masters embodying ${work}, identified by CBT code ${asset.cbtCode}.`;
    case 'purchasePrice':
      return `The purchase price for the masters is ${fields.fee}, payable through the Covenant settlement pipeline and disbursed to the sellers at their exact recorded percentages.`;
    case 'interactiveUse':
      return `The composition may be synchronized, reproduced, and distributed solely as interactive audiovisual content within the game or interactive product the Parties have agreed in writing, across all platforms, versions, patches, and downloadable releases of that product; no other use is licensed under this Agreement.`;
    case 'performanceRelease':
      return `The releasing Party grants a perpetual release of the recorded voice performance, motion-capture performance, and related likeness data captured for ${work}, in ${fields.territory}, for gameplay, streaming, promotional, and archival use by the production.`;
    case 'channelShare':
      return `Net receipts actually received by the channel or platform operator for ${work} are shared among the Parties at their exact recorded percentages in the Covenant pools. Settlement runs through the Covenant pipeline, and the embedded auditor reconciles every distribution against the split sheet before it posts.`;
    case 'scoreDelivery':
      return `The composing Party shall deliver the original score cues, stems, and session materials for ${work} in the formats customarily required for mixing and mastering, and shall make reasonable revisions within the agreed scope before final delivery.`;
    case 'directorialServices':
      return `The commissioning Party engages the directing Party as the sole and exclusive director of ${work}, and the directing Party accepts the engagement, for picture and allied rights on the terms of this Agreement.`;
    case 'coHostEpisodes':
      return `The Parties' co-hosting and guest contributions to episodes of ${work} are recorded in the Covenant pools; each Party's credit, ownership, and receipts follow its recorded percentage exactly.`;
    case 'sponsorshipDeliverables':
      return `The talent shall produce and publish the sponsored content pieces for the campaign in connection with ${work} as expressly agreed in writing between the Parties, each piece credited to its recorded creators in the Covenant registry.`;
    case 'studioRoyalty':
      return `Net receipts of the game or interactive product are shared between the developer and studio Parties at their exact recorded percentages in the Covenant pools, which are authoritative and sum to 100.0000%.`;
    case 'delivery':
      return `Delivery of the purchased masters and all related materials is complete upon the buyer's acceptance, after which the Covenant registry record of ownership governs all further exploitation.`;
    case 'warranties':
      return `Each Party warrants that it owns and controls the rights it purports to grant, that the recorded percentages are true and complete, and that exploitation of the Work per this Agreement will not infringe any third party's rights. This Agreement and the settlement of its proceeds are governed by ${law}.`;
    case 'originalWork':
      return `The original work ${work}, identified by CBT code ${asset.cbtCode}, remains the property of its recorded owners; nothing in this Agreement transfers the original except as expressly stated.`;
    case 'remixScope':
      return `The remixing Party may create a derivative remix of the original work strictly within the scope agreed in writing, using only the materials furnished for the remix.`;
    case 'clearance':
      return `The remixer's rights are cleared for the Territory (${fields.territory}) for the Term (${fields.term}), subject to the Covenant registry's recorded ownership and the auditor's settlement reconciliation.`;
    case 'property':
      return `The property under option is the screenplay ${work}, identified by CBT code ${asset.cbtCode} (display code ${asset.displayCode}), together with all rights of every kind therein owned or controlled by the owner as recorded in the Covenant registry.`;
    case 'optionGrant':
      return `The owner grants the producer an exclusive option to acquire the motion picture and allied rights in the property on the terms of this Agreement.`;
    case 'optionFee':
      return `The option fee is ${fields.fee}, earned upon payment and non-refundable against the purchase price if the option is exercised.`;
    case 'production':
      return `The Party's name, likeness, performance, and contribution in connection with the production of ${work} are released on the terms below. The production is identified by Covenant Block code ${asset.cbtCode}${asset.identifiers.some((i) => i.label === 'EIDR') ? ` and by its EIDR ${asset.identifiers.find((i) => i.label === 'EIDR')!.value}` : ''}, and the identifiers registered for the Work in the Covenant registry are incorporated by reference.`;
    case 'releaseGrant':
      return `The releasing Party grants the production a perpetual release to record, reproduce, distribute, and exhibit the contribution in connection with ${work} and its advertising, in ${fields.territory}.`;
    case 'consideration':
      return `Consideration for the release is ${fields.fee} or, where the Covenant pools record a share, the releasing Party's exact recorded percentage of net receipts attributable to the Work.`;
    case 'publicity':
      return `The production may use the releasing Party's name, likeness, and biographical material to publicize ${work}, without additional consideration beyond that stated above.`;
    case 'artwork':
      return `The consignor delivers the artwork ${work} (medium: ${asset.mediumLabel}), identified by CBT code ${asset.cbtCode} (display code ${asset.displayCode}), to the consignee for sale on consignment.`;
    case 'consignmentTerm':
      return `The consignment runs for ${fields.term} from ${effectiveDate(fields)}, covering the Territory (${fields.territory}).`;
    case 'insurance':
      return `The consignee shall insure the artwork against all risks of physical loss or damage while in its custody at no cost to the consignor, and is responsible for its safekeeping.`;
    case 'settlement':
      return `Proceeds of any sale are settled through the Covenant settlement pipeline: the commission stated below is deducted, and the balance is disbursed to the consignor at the recorded percentages and reconciled by the embedded auditor. Governing law: ${law}.`;
    case 'campaign':
      return `This Agreement engages the talent for the brand campaign in connection with ${work} (CBT ${asset.cbtCode}), on the terms below.`;
    case 'designLicense':
      return `The licensor grants the licensee the right to reproduce, produce, and distribute garments and accessories embodying the design ${work}, identified by CBT code ${asset.cbtCode} (display code ${asset.displayCode}), throughout the Territory (${fields.territory}) for the Term (${fields.term}), subject to the ownership recorded in the Covenant registry.`;
    case 'apparelProduction':
      return `The manufacturer produces the apparel line derived from ${work} (CBT ${asset.cbtCode}) strictly to the tech packs, materials, and sample approvals recorded in the Covenant registry, at the unit quantities and production schedule agreed in writing.`;
    case 'collabContent':
      return `The Parties collaborate on the co-branded capsule in connection with ${work} (CBT ${asset.cbtCode}); each Party's design and production contributions are credited exactly as recorded in the Covenant registry, and proceeds reconcile through the embedded auditor at the recorded percentages.`;
    case 'runwayRelease':
      return `The releasing Party's walk, likeness, and performance in the runway presentation of ${work} are captured and released for the event's documentation, archive, and promotion, in ${fields.territory}, with the identifiers registered for the Work in the Covenant registry incorporated by reference.`;
    case 'usage':
      return `All content produced under this Agreement may be used by the brand in ${fields.territory} for the Term (${fields.term}), credited to its creators as recorded in the Covenant registry.`;
    case 'expenses':
      return `Reasonable, pre-approved expenses incurred in the engagement are reimbursable and are reconciled through the Covenant ledger before settlement.`;
    case 'termination':
      return `Either Party may terminate for uncured material breach on written notice. Accrued payment obligations and the recorded pool percentages survive termination. This Agreement is governed by ${law}.`;
    case 'signatures':
      return signatureBody(ctx);
    default:
      return `The Parties agree that ${CLAUSE_LABELS[clause] ?? clause} applies to ${work} as recorded in the Covenant registry.`;
  }
}

/** Renders the template's clauses in order — pure and deterministic. */
export function renderClauses(template: ContractTemplate, ctx: AgreementContext): string {
  const header = [
    template.name.toUpperCase(),
    'Covenant Block: ' + ctx.asset.cbtCode + ' · Display: ' + ctx.asset.displayCode,
    '',
  ].join('\n');

  const body = template.clauseOrder
    .map((clause, i) => {
      const title = `${i + 1}. ${(CLAUSE_LABELS[clause] ?? clause).toUpperCase()}`;
      return `${title}\n\n${clauseBody(clause, template, ctx)}`;
    })
    .join('\n\n');

  return `${header}\n${body}\n`;
}

/**
 * Spec contract: generateAgreement(template, ctx) → { templateId, fields, document }.
 * Deterministic — identical inputs yield identical documents.
 */
export function generateAgreement(
  template: ContractTemplate,
  ctx: AgreementContext,
): GeneratedAgreement {
  return {
    templateId: template.id,
    fields: ctx,
    document: renderClauses(template, ctx),
  };
}

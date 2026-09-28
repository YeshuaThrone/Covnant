/**
 * The registration agent's draft contract — the single source of truth for
 *
 *   1. the agent tool schema (what the model must emit, fed to the Anthropic
 *      Messages API as the tool definition),
 *   2. the review-screen contract (what the route responds with and what the
 *      creator edits), and
 *   3. the system prompt text (the agent's instructions, kept beside the
 *      schema so the two cannot drift).
 *
 * EXISTING SHAPES ONLY (spec locked decision): every registry field mirrors
 * the write path's types 1:1 — `MEDIA_MEDIUMS`, `POOL_NAMES`,
 * `RIGHTS_HOLDER_ROLES`, `TAX_FORM_TYPES` come from `src/lib/splits/shared.ts`
 * and are NEVER redefined here, and the per-pool exact-100.0000% gate reuses
 * the write path's own fixed-point arithmetic (`poolUnitsFromShares` /
 * `TARGET_UNITS`), so a draft that passes this schema is byte-compatible with
 * a `PoolDraft[]` the manual studio form could have produced.
 *
 * PROPOSE-NEVER-WRITE: this module imports no store and performs no I/O. It
 * is client-safe (the review screen validates with the same schema the route
 * validates with). The only compile-time link to the write path is the
 * type-only `RegisterAssetPayload` import below, which is erased at build —
 * the import-boundary test walks runtime imports and skips `import type` for
 * exactly this reason.
 */

import { z } from 'zod';

import type { RegisterAssetPayload } from '@/lib/assets/actions';
import { TEMPLATES } from '@/lib/contracts/templates';
import {
  MEDIA_MEDIUMS,
  POOL_NAMES,
  RIGHTS_HOLDER_ROLES,
  TAX_FORM_TYPES,
  TARGET_UNITS,
  poolUnitsFromShares,
  type HolderDraft,
  type HolderRoutingDraft,
} from '@/lib/splits/shared';

/**
 * Below this confidence the route escalates once to the stronger model.
 * Exported because the review screen renders an honest low-confidence flag
 * with the same number.
 */
export const AGENT_CONFIDENCE_THRESHOLD = 0.7;

/** The Anthropic tool name the draft is requested through. */
export const AGENT_DRAFT_TOOL_NAME = 'propose_registration_draft';

// ---------------------------------------------------------------------------
// Holder / routing schemas — one base shape, two layers.
//
// The MODEL never emits holder ids (the system prompt says so and the tool
// schema omits the field): ids are assigned at parse time by
// `parseAgentToolInput`, mirroring the write path's rule that the agent never
// fabricates holder identities. The review contract then requires the id —
// `HolderDraft` carries one, and `holdersFromDrafts` passes it through.
// ---------------------------------------------------------------------------

const holderBase = {
  name: z.string().min(1),
  role: z.enum(RIGHTS_HOLDER_ROLES),
  /** True per-pool share, e.g. 33.3333. The studio edits and displays this. */
  splitPercentage: z.number().min(0).max(100),
  taxFormType: z.enum(TAX_FORM_TYPES),
  usTaxResident: z.boolean(),
  treatyCountryCode: z.string().min(1).optional(),
  treatyWithholdingRate: z.number().min(0).max(100).optional(),
  isVerified: z.boolean(),
  routing: z.object({
    accountHolderName: z.string(),
    bankName: z.string(),
    accountNumberOrIBAN: z.string(),
    routingOrBIC: z.string(),
    currency: z.string().min(1),
    countryCode: z.string().min(1),
    planetaryJurisdiction: z.enum(['EARTH', 'MARS', 'ORBITAL']),
    railType: z.string().min(1),
  }),
};

/** What the model emits per holder — no `id`. */
const toolHolderSchema = z.object(holderBase);

/** What the review screen edits per holder — the full `HolderDraft` mirror. */
const reviewHolderSchema = z.object({ id: z.string().min(1), ...holderBase });

// Compile pin: the review holder is assignable to the write path's HolderDraft.
type ReviewHolder = z.infer<typeof reviewHolderSchema>;
export const REVIEW_HOLDER_MIRROR_PIN = true as ReviewHolder extends HolderDraft ? true : never;

// ---------------------------------------------------------------------------
// Pool schema — the exact-100.0000% gate, at the SAME units as the save gate.
// ---------------------------------------------------------------------------

/**
 * Exact per-pool sum in the engine's unit space. A caught
 * FixedPointParseError (more than 4 decimal places on a share) is a draft
 * validation failure, never a thrown crash.
 */
function poolSumIsExact(shares: number[]): boolean {
  try {
    // TARGET_UNITS is a number; the sum is a bigint — same wrap the save
    // gate's poolStateForUnits does before comparing.
    return poolUnitsFromShares(shares) === BigInt(TARGET_UNITS);
  } catch {
    return false;
  }
}

function poolsSchema<H extends typeof toolHolderSchema | typeof reviewHolderSchema>(
  holder: H,
): z.ZodArray<
  z.ZodObject<{
    pool: typeof poolNameSchema;
    holders: z.ZodArray<H>;
  }>
> {
  return z
    .array(
      z
        .object({ pool: poolNameSchema, holders: z.array(holder).min(1) })
        .superRefine((pool, ctx) => {
          if (!poolSumIsExact(pool.holders.map((h) => h.splitPercentage))) {
            ctx.addIssue({
              code: 'custom',
              path: ['holders'],
              message:
                'Each pool must sum to exactly 100.0000% (the write path rejects anything else).',
            });
          }
        }),
    )
    .min(1) as z.ZodArray<
    z.ZodObject<{
      pool: typeof poolNameSchema;
      holders: z.ZodArray<H>;
    }>
  >;
}

const poolNameSchema = z.enum(POOL_NAMES);

// ---------------------------------------------------------------------------
// Draft schemas — tool input (no ids) and review contract (ids required).
// ---------------------------------------------------------------------------

const draftBase = {
  /** Non-empty after trim — the write path rejects a whitespace-only title. */
  title: z.string().min(1).refine((t) => t.trim().length > 0),
  medium: z.enum(MEDIA_MEDIUMS),
  identifiers: z.object({
    isrc: z.string().min(1).optional(),
    iswc: z.string().min(1).optional(),
    eidrCanonical: z.string().min(1).optional(),
  }),
};

const metadataBase = {
  /** 0–1 from the model; below AGENT_CONFIDENCE_THRESHOLD the route escalates once. */
  confidence: z.number().min(0).max(1),
  /** Every field the agent defaulted, in plain words. Rendered as flags. */
  assumptions: z.array(z.string()),
};

/**
 * The template suggestion is validated against the live catalog: an
 * unresolved templateId is DROPPED (spec locked decision), not rejected — a
 * hallucinated id costs the suggestion, never the draft.
 */
export function resolveTemplateSuggestion(
  suggestion: { templateId: string; rationale: string } | undefined,
): { templateId: string; rationale: string } | undefined {
  if (!suggestion) return undefined;
  return TEMPLATES.some((t) => t.id === suggestion.templateId) ? suggestion : undefined;
}

/** The tool schema the model is invoked against (JSON-Schema-generated). */
export const agentToolInputSchema = z.object({
  ...draftBase,
  pools: poolsSchema(toolHolderSchema),
  templateSuggestion: z
    .object({ templateId: z.string(), rationale: z.string() })
    .optional(),
  ...metadataBase,
});

/** The review contract: `RegisterAssetPayload` shapes + agent review metadata. */
export const agentRegistrationDraftSchema = z.object({
  ...draftBase,
  pools: poolsSchema(reviewHolderSchema),
  templateSuggestion: z
    .object({ templateId: z.string(), rationale: z.string() })
    .transform(resolveTemplateSuggestion)
    .pipe(z.object({ templateId: z.string(), rationale: z.string() }).optional()),
  ...metadataBase,
});

export type AgentToolInput = z.infer<typeof agentToolInputSchema>;
export type AgentRegistrationDraft = z.infer<typeof agentRegistrationDraftSchema>;

/**
 * The write path's `RegisterAssetPayload` on its own — the review screen's
 * confirm gate. The creator-edited editor state must parse against THIS
 * before the confirm button enables, so a draft the server would reject
 * never leaves the client. Holders are the full `HolderDraft` mirror
 * (client-assigned ids included); each pool re-checks the exact-100.0000%
 * gate in the engine's unit space.
 */
export const registerAssetPayloadSchema = z.object({
  ...draftBase,
  pools: poolsSchema(reviewHolderSchema),
});

// Compile pin: the gate schema's output is assignable to the action's payload.
type RegisterPayloadShape = z.infer<typeof registerAssetPayloadSchema>;
export const REGISTER_PAYLOAD_MIRROR_PIN = true as RegisterPayloadShape extends RegisterAssetPayload
  ? true
  : never;

export type AgentTemplateSuggestion = NonNullable<AgentRegistrationDraft['templateSuggestion']>;

// ---------------------------------------------------------------------------
// Parsing — the route's strict boundary between model output and a draft.
// ---------------------------------------------------------------------------

export type AgentToolParseResult =
  | { ok: true; draft: AgentRegistrationDraft }
  | { ok: false; issues: string[] };

/**
 * Strict parse + normalize of the model's tool input:
 *   1. validate against the tool schema (no holder ids accepted),
 *   2. assign ids the write path requires (the agent never fabricates them),
 *   3. re-validate against the review contract — the same schema the review
 *      screen validates the edited draft with before confirming.
 * Malformed output never becomes a draft — the caller maps the issues to the
 * clean `agent_draft_invalid` failure.
 */
export function safeParseAgentToolInput(toolInput: unknown): AgentToolParseResult {
  const tool = agentToolInputSchema.safeParse(toolInput);
  if (!tool.success) {
    return { ok: false, issues: tool.error.issues.map(describeIssue) };
  }
  const withIds = {
    ...tool.data,
    pools: tool.data.pools.map((pool) => ({
      ...pool,
      holders: pool.holders.map((holder) => ({ id: crypto.randomUUID(), ...holder })),
    })),
  };
  const review = agentRegistrationDraftSchema.safeParse(withIds);
  if (!review.success) {
    return { ok: false, issues: review.error.issues.map(describeIssue) };
  }
  return { ok: true, draft: review.data };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

/**
 * The confirm payload — exactly what `registerAssetAction` accepts, with the
 * agent-only review metadata stripped. This is the ONE function the review
 * screen's confirm uses; no draft metadata ever reaches the write action.
 */
export function registerAssetPayloadFromDraft(draft: AgentRegistrationDraft): RegisterAssetPayload {
  return {
    title: draft.title,
    medium: draft.medium,
    identifiers: draft.identifiers,
    pools: draft.pools,
  };
}

// Compile pin: the extracted payload is assignable to the write action's shape.
export const PAYLOAD_MIRROR_PIN = true as ReturnType<
  typeof registerAssetPayloadFromDraft
> extends RegisterAssetPayload
  ? true
  : never;

// ---------------------------------------------------------------------------
// The Anthropic tool definition — generated from the tool schema, never
// hand-maintained, so the model's contract cannot drift from the validator.
// ---------------------------------------------------------------------------

export const AGENT_TOOL_DEFINITION = {
  name: AGENT_DRAFT_TOOL_NAME,
  description:
    'Propose a structured Covenant Block registration draft (title, medium, identifiers, ' +
    'pools with holders and splits, contract template suggestion, confidence, assumptions) ' +
    'extracted from the creator’s prose description.',
  input_schema: z.toJSONSchema(agentToolInputSchema),
} as const;

// ---------------------------------------------------------------------------
// Placeholder defaults the AGENT may apply — each one must land in
// assumptions[] so the review screen surfaces it. The schema never applies
// defaults silently; the system prompt instructs the model to.
// ---------------------------------------------------------------------------

/** The empty-bank placeholder mirrors the studio's `emptyHolder()` routing. */
export const AGENT_ROUTING_PLACEHOLDER: HolderRoutingDraft = {
  accountHolderName: '',
  bankName: '',
  accountNumberOrIBAN: '',
  routingOrBIC: '',
  currency: 'USD',
  countryCode: 'US',
  planetaryJurisdiction: 'EARTH',
  railType: 'MANUAL',
};

/**
 * The agent's system prompt. Single source of truth beside the tool schema:
 * the placeholder defaults and the exact-100.0000% rule stated here are the
 * same ones the schema enforces.
 */
export const AGENT_REGISTRATION_SYSTEM_PROMPT = [
  'You are Covnant’s registration copilot: an A&R assistant that turns a creator’s',
  'free-form description of their work into ONE structured registration draft.',
  '',
  'Extract, never invent:',
  '- title: the work’s name as the creator described it (never a placeholder).',
  '- medium: exactly one of the enumerated mediums.',
  '- identifiers: only ISRC / ISWC / EIDR values the creator actually gave you; omit otherwise.',
  '- pools and holders: only holders the creator described, by the names they used.',
  '  Roles must come from the enumerated list — pick the closest honest match and say so in assumptions.',
  '- splitPercentage: TRUE per-pool shares. Each pool’s holders must sum to EXACTLY 100.0000%',
  '  (four decimal places). Never split a pool you have no holder information for.',
  '',
  'Defaults you may apply — and then MUST flag:',
  '- Unknown tax form → taxFormType "EXEMPT", usTaxResident false.',
  '- Unknown payout routing → the placeholder routing: currency "USD", countryCode "US",',
  '  planetaryJurisdiction "EARTH", railType "MANUAL", empty bank fields.',
  '- isVerified: always false. Verification happens elsewhere; never claim it.',
  '- Every defaulted field gets ONE plain-words line in assumptions. A default the creator',
  '  cannot see on the review screen is a bug.',
  '',
  `templateSuggestion: pick at most one template id from this list — ${TEMPLATES.map((t) => t.id).join(', ')} —`,
  'with a one-line rationale grounded in the work described. Omit the suggestion entirely if none fits.',
  '',
  'confidence: 0–1, your honest certainty that the draft matches the creator’s intent.',
  'Below 0.7 the system retries with a stronger model, so do not inflate: an honest 0.4 is',
  'more useful than a lucky 0.9. Name every guess in assumptions.',
  '',
  'Never emit holder ids — the system assigns them. Never emit fields the tool schema does not',
  'declare. You propose; only the creator’s explicit confirmation writes anything.',
].join('\n');

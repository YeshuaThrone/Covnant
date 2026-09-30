/**
 * Recon job request/callback validation (spec art_7M0snhxc, build item 2).
 *
 * The enqueue body is deliberately tiny — {source, ingest_id?} — because
 * the enqueue route is the UCT layer's ONE write: it validates the shape,
 * checks ownership where the schema can prove it, inserts one row, and
 * returns 202. `source` reuses the statement_ingests vocabulary (the
 * recon worker parses statements these rows describe); `ingest_id` is a
 * UUID referencing that table.
 *
 * The callback body is the pg_net completion webhook's payload: the
 * migration's trigger POSTs {job_id, status, error, result} — the result
 * summary is the worker's own outcome (written before the trigger fired),
 * carried through for the missed-trigger fallback so the callback never
 * invents counts.
 */

import { z } from 'zod';

import { RECON_JOB_SOURCES } from './records';

/** Announced terminal statuses the callback applies (the trigger's vocabulary). */
export const RECON_CALLBACK_STATUSES = ['completed', 'failed'] as const;

/** The worker's outcome summary — schema-validated, never invented here. */
const reconJobResultSchema = z.object({
  events_written: z.number().int().min(0),
  matched: z.number().int().min(0),
  unmatched: z.number().int().min(0),
  engine_used: z.string().min(1).nullable(),
});

export const reconJobRequestSchema = z.object({
  source: z.enum(RECON_JOB_SOURCES),
  ingest_id: z.uuid().optional(),
});

export const reconJobCallbackSchema = z.object({
  job_id: z.uuid(),
  status: z.enum(RECON_CALLBACK_STATUSES),
  error: z.string().min(1).nullish(),
  result: reconJobResultSchema.nullish(),
});

export type ReconJobCallbackPayload = z.infer<typeof reconJobCallbackSchema>;

export type ReconJobRequestParse =
  | { ok: true; value: { source: (typeof RECON_JOB_SOURCES)[number]; ingest_id?: string } }
  | { ok: false; message: string };

/** Parses the enqueue body into the store input's shape, or a 422 message. */
export function parseReconJobRequest(body: unknown): ReconJobRequestParse {
  const parsed = reconJobRequestSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const field = first?.path?.join('.') ?? 'body';
  return {
    ok: false,
    message: `Invalid recon job request: ${field} — ${first?.message ?? 'malformed payload'}.`,
  };
}

export type ReconJobCallbackParse =
  | { ok: true; value: ReconJobCallbackPayload }
  | { ok: false; message: string };

/** Parses the signed callback body, or a 422 message. */
export function parseReconJobCallback(body: unknown): ReconJobCallbackParse {
  const parsed = reconJobCallbackSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const field = first?.path?.join('.') ?? 'body';
  return {
    ok: false,
    message: `Invalid recon job callback: ${field} — ${first?.message ?? 'malformed payload'}.`,
  };
}

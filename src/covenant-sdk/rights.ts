/**
 * The four Covenant rights pipelines. Collection nodes must cover all four.
 */

export const RIGHTS_PIPELINES = [
  "composition_performance",
  "composition_mechanical",
  "master_digital_performance",
  "master_interactive",
] as const;

export const RIGHTS_PIPELINE_CODES = RIGHTS_PIPELINES;
export const RIGHTS_PIPELINE_COUNT = RIGHTS_PIPELINES.length;

export type RightsPipeline = (typeof RIGHTS_PIPELINES)[number];

export const RIGHTS_PIPELINE_LABELS: Record<RightsPipeline, string> = {
  composition_performance: "Composition Performance",
  composition_mechanical: "Composition Mechanical",
  master_digital_performance: "Master Digital Performance",
  master_interactive: "Master Interactive",
};

export function isRightsPipeline(value: string): value is RightsPipeline {
  return (RIGHTS_PIPELINES as readonly string[]).includes(value);
}

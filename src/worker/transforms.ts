import type { Lane } from "../core/lanes.ts";
import type { Env } from "./env.ts";
import type { IngestedAttachment } from "./ingest.ts";

export interface TransformResult {
  /** Files extracted from the attachment. Empty if nothing applied or it failed. */
  children: IngestedAttachment[];
  /** Set when a transform applied but failed. The message is still stored. */
  error: string | null;
}

export async function runTransforms(
  _lane: Lane,
  _attachment: IngestedAttachment,
  _env: Env,
  _fileBudget: number,
): Promise<TransformResult> {
  return { children: [], error: null };
}

import type { Lane } from "../core/lanes.ts";
import type { Env } from "./env.ts";
import type { IngestedAttachment } from "./ingest.ts";
import { unzip } from "./unzip.ts";

export interface TransformResult {
  /** Files extracted from the attachment. Empty if nothing applied or it failed. */
  children: IngestedAttachment[];
  /** Set when a transform applied but failed. The message is still stored. */
  error: string | null;
}

/**
 * Runs the lane's transforms on one stored attachment. Transforms are reviewed
 * code that a lane opts into; there are no user-supplied scripts. A transform
 * that fails never rejects the message, which has already passed the sender checks.
 */
export async function runTransforms(
  lane: Lane,
  attachment: IngestedAttachment,
  env: Env,
  fileBudget: number,
): Promise<TransformResult> {
  for (const transform of lane.attachmentPolicy.transforms) {
    if (transform.type === "unzip" && attachment.type === "application/zip") {
      // The password is scoped to this lane: only the secret the lane names is read.
      const password = env[transform.password_secret as `LANE_SECRET_${string}`];
      const result = await unzip(attachment.bytes, {
        password: password || undefined,
        allowInnerTypes: transform.allow_inner_types,
        maxFiles: fileBudget,
      });
      return result.ok ? { children: result.files, error: null } : { children: [], error: result.error };
    }
  }
  return { children: [], error: null };
}

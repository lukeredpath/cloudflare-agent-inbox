import type { LaneStatus } from "../worker/admin/types.ts";
import { ApiRequestError, put } from "./api.ts";
import { refreshAll } from "./data.ts";
import { toast } from "./toast.tsx";

export const errorText = (e: unknown): string => (e instanceof ApiRequestError ? e.message : "Something went wrong.");

/**
 * Runs a change and reports the outcome. Success reloads what is on screen; failure says why and
 * changes nothing. Returns whether it worked.
 */
export async function attempt(change: () => Promise<unknown>, success?: string, undo?: () => void): Promise<boolean> {
  try {
    await change();
  } catch (e) {
    toast(errorText(e));
    return false;
  }
  refreshAll();
  if (success) toast(success, undo);
  return true;
}

/** Pausing and resuming are the one lane change that can be undone, so it offers to. */
export async function setLaneStatus(slug: string, to: LaneStatus): Promise<void> {
  const back: LaneStatus = to === "paused" ? "active" : "paused";
  await attempt(
    () => put(`/api/lanes/${slug}/status`, { status: to }),
    `${slug} ${to === "paused" ? "paused. New mail to it is rejected." : "resumed."}`,
    () => void setLaneStatus(slug, back),
  );
}

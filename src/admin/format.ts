const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const FULL = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** `19 Nov, 12:37`. */
export const formatWhen = (iso: string): string => WHEN.format(new Date(iso));
/** `19 Nov 2026, 12:37`, for tooltips. */
export const formatFull = (iso: string): string => FULL.format(new Date(iso));
export const formatDay = (iso: string): string => DAY.format(new Date(iso));

export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "Never";
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The reasons the Worker records, in words. */
export const REASONS: Record<string, string> = {
  unknown_address: "Unknown recipient",
  sender_not_allowed: "Sender not allowed",
  auth_failed: "Authentication failed",
  lane_paused: "Lane paused",
  too_large: "Message too large",
  attachment_not_allowed: "Attachment type not allowed",
  parse_error: "Could not be read",
};
export const reasonLabel = (reason: string): string => REASONS[reason] ?? reason;

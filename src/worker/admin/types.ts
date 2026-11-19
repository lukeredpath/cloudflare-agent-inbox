/** Shapes shared by the admin API and the admin app. Types only: the app imports them with `import type`. */

export interface SessionView {
  /** The Access identity's email, if it has one (service tokens do not). */
  email: string | null;
}

export interface LaneListItem {
  slug: string;
  description: string;
  status: "active" | "paused";
  messageCount: number;
  unprocessedCount: number;
  lastReceivedAt: string | null;
}

export interface ApiError {
  error: string;
}

/**
 * Shapes shared by the admin API and the admin app. Types only: the app imports them with `import type`.
 *
 * Anything that came from an email, or text an agent wrote about one, is in a field whose name starts with
 * `untrusted_`, the same rule as the agent-facing MCP. The app renders those only through its untrusted
 * components, as text.
 */

export interface SessionView {
  /** The Access identity's email, if it has one (service tokens do not). */
  email: string | null;
}

export type LaneStatus = "active" | "paused";
export type Verdict = "dmarc" | "dkim" | "spf";

export interface LaneListItem {
  slug: string;
  description: string;
  status: LaneStatus;
  message_count: number;
  unprocessed_count: number;
  last_received_at: string | null;
  agent_count: number;
}

export interface OverviewView {
  lanes: LaneListItem[];
  transform_failures: { slug: string; count: number }[];
  /** Rejections logged in the last 48 hours. */
  rejections_48h: { probe: number; lane: number };
}

export interface UnzipTransformView {
  type: "unzip";
  password_secret: string;
  allow_inner_types: string[];
}

export interface LaneView {
  slug: string;
  description: string;
  status: LaneStatus;
  /** Enough of the address to recognise it. The full address has its own endpoint. */
  address_masked: string;
  /** null = the deployment default. */
  allowed_senders: string[] | null;
  forwarded_from: { from: string; require: Verdict[] }[];
  blocked_senders: string[];
  shareable: boolean;
  attachment_policy: { allowed_types: string[]; max_attachment_bytes: number; transforms: UnzipTransformView[] };
  max_bytes: number;
  max_text_chars: number;
  retention_days: number;
  created_at: string;
  updated_at: string;
}

export interface MessageListItem {
  id: string;
  lane: string;
  received_at: string;
  untrusted_envelope_from: string;
  untrusted_subject: string | null;
  size: number;
  attachment_count: number;
  transform_error_count: number;
  is_test: boolean;
  keep: boolean;
  processed: { by: string; at: string } | null;
}

export interface AttachmentView {
  id: string;
  parent_id: string | null;
  untrusted_filename: string;
  untrusted_content_type: string;
  size: number;
  untrusted_transform_error: string | null;
}

export interface MessageDetail extends MessageListItem {
  untrusted_header_from: string | null;
  untrusted_original_from: string | null;
  untrusted_auth_summary: string | null;
  untrusted_processed_note: string | null;
  attachments: AttachmentView[];
}

export interface RejectionView {
  id: string;
  received_at: string;
  bucket: "probe" | "lane";
  lane: string | null;
  reason: string;
  untrusted_recipient_hint: string;
  untrusted_envelope_from: string;
  untrusted_header_from: string | null;
  untrusted_detail: string | null;
  untrusted_diagnostics: string | null;
}

export interface ShareView {
  agent: string | null;
  untrusted_filename: string;
  expires_at: string;
  created_at: string;
}

export interface TransformFailureView {
  message_id: string;
  attachment_id: string;
  received_at: string;
  untrusted_filename: string;
  untrusted_error: string;
}

export interface LaneDetail {
  lane: LaneView;
  message_count: number;
  unprocessed_count: number;
  recent_messages: MessageListItem[];
  /** Agents with a live token that can read this lane, and those that could be granted it. */
  agents: string[];
  grantable_agents: string[];
  shares: ShareView[];
  transform_failures: TransformFailureView[];
  rejections: RejectionView[];
}

export interface AgentView {
  name: string;
  created_at: string;
  revoked_at: string | null;
  lanes: string[];
}

export interface ApiError {
  error: string;
  /** Present for validation failures: one entry per problem, with a dotted path into the request body. */
  issues?: { path: string; message: string }[];
}

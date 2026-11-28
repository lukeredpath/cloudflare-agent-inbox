import { buildAddress } from "../../core/address.ts";
import type { Agent } from "../../core/agents.ts";
import type { IngestKey } from "../../core/ingest-keys.ts";
import type { Lane } from "../../core/lanes.ts";
import type { AttachmentRow, MessageRow } from "../../core/messages.ts";
import type { RejectionRow } from "../../core/rejections.ts";
import type { Env } from "../env.ts";
import type { AgentView, AttachmentView, IngestKeyView, LaneView, MessageDetail, MessageListItem, RejectionView } from "./types.ts";

/** Enough to recognise an address by, never enough to use it. */
export function maskedAddress(lane: Lane, mailHostname: string): string {
  return buildAddress(`${lane.addressToken.slice(0, 5)}${"•".repeat(12)}`, mailHostname);
}

export const fullAddress = (lane: Lane, mailHostname: string): string => buildAddress(lane.addressToken, mailHostname);

export function laneView(lane: Lane, mailHostname: string): LaneView {
  return {
    slug: lane.slug,
    description: lane.description,
    status: lane.status,
    address_masked: maskedAddress(lane, mailHostname),
    allowed_senders: lane.allowedSenders,
    forwarded_from: lane.forwardedFrom,
    blocked_senders: lane.blockedSenders,
    shareable: lane.shareable,
    attachment_policy: lane.attachmentPolicy,
    max_bytes: lane.maxBytes,
    max_text_chars: lane.maxTextChars,
    retention_days: lane.retentionDays,
    created_at: lane.createdAt,
    updated_at: lane.updatedAt,
  };
}

export function messageItem(m: MessageRow): MessageListItem {
  return {
    id: m.id,
    lane: m.lane_slug,
    received_at: m.received_at,
    untrusted_envelope_from: m.envelope_from,
    untrusted_subject: m.subject,
    size: m.size,
    attachment_count: m.attachment_count,
    transform_error_count: m.transform_error_count,
    is_test: m.is_test === 1,
    keep: m.keep === 1,
    processed: m.processed_at ? { by: m.processed_by ?? "", at: m.processed_at } : null,
  };
}

export const attachmentView = (a: AttachmentRow): AttachmentView => ({
  id: a.id,
  parent_id: a.parent_id,
  untrusted_filename: a.filename,
  untrusted_content_type: a.content_type,
  size: a.size,
  untrusted_transform_error: a.transform_error,
});

export function messageDetail(m: MessageRow, attachments: AttachmentRow[]): MessageDetail {
  return {
    ...messageItem(m),
    untrusted_header_from: m.header_from,
    untrusted_original_from: m.original_from,
    untrusted_auth_summary: m.auth_summary,
    untrusted_processed_note: m.processed_note,
    attachments: attachments.map(attachmentView),
  };
}

export const rejectionView = (r: RejectionRow): RejectionView => ({
  id: r.id,
  received_at: r.received_at,
  bucket: r.bucket === "probe" ? "probe" : "lane",
  lane: r.lane_slug,
  reason: r.reason,
  untrusted_recipient_hint: r.recipient_hint,
  untrusted_envelope_from: r.envelope_from,
  untrusted_header_from: r.header_from,
  untrusted_detail: r.detail,
  untrusted_diagnostics: r.diagnostics,
});

export const agentView = (a: Agent, lanes: string[]): AgentView => ({
  name: a.name,
  created_at: a.createdAt,
  revoked_at: a.revokedAt,
  lanes,
});

export const ingestKeyView = (k: IngestKey): IngestKeyView => ({
  id: k.id,
  created_at: k.createdAt,
  last_used_at: k.lastUsedAt,
  revoked_at: k.revokedAt,
});

/** The lane's ingest URL, only when the ingest host would actually serve it (see handleIngest). */
export function ingestEndpoint(env: Env, slug: string): string | null {
  if (!env.INGEST_HOSTNAME || !env.ACCESS_TEAM_DOMAIN || !env.INGEST_ACCESS_AUD || !env.INGEST_PRIVATE_KEY) return null;
  return `https://${env.INGEST_HOSTNAME}/ingest/lanes/${slug}`;
}

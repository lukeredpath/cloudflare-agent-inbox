import { z } from "zod";
import { deleteMessage, getAttachmentAdmin, getMessageAdmin, listAttachments, listMessagesAdmin, markUnprocessed, setKeep } from "../../../core/messages.ts";
import { getLaneBySlug } from "../../../core/lanes.ts";
import { ApiFailure, json, readJson } from "../http.ts";
import { messageDetail, messageItem } from "../views.ts";
import { ID, type Route } from "./route.ts";

const KeepBody = z.strictObject({ keep: z.boolean() });
const STATUSES = ["all", "unprocessed", "processed"] as const;

const notFound = () => new ApiFailure(404, "message not found");

export const messageRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/messages$/,
    name: "messages.list",
    handler: async (ctx) => {
      const q = ctx.url.searchParams;
      const status = q.get("status") ?? "all";
      if (!(STATUSES as readonly string[]).includes(status)) throw new ApiFailure(400, "unknown status");
      const limit = Number(q.get("limit") ?? 100);
      if (!Number.isInteger(limit) || limit < 1) throw new ApiFailure(400, "invalid limit");
      let laneId: string | undefined;
      if (q.get("lane")) {
        const lane = await getLaneBySlug(ctx.db, q.get("lane")!);
        if (!lane) throw new ApiFailure(404, "lane not found");
        laneId = lane.id;
      }
      const rows = await listMessagesAdmin(ctx.db, {
        laneId,
        unprocessedOnly: status === "unprocessed",
        processedOnly: status === "processed",
        limit,
      });
      return json(200, rows.map(messageItem));
    },
  },

  {
    method: "GET",
    pattern: new RegExp(`^/api/messages/${ID}$`),
    name: "messages.get",
    handler: async (ctx) => {
      const message = await getMessageAdmin(ctx.db, ctx.params[0]!);
      if (!message) throw notFound();
      return json(200, messageDetail(message, await listAttachments(ctx.db, message.id)));
    },
  },

  {
    // Bodies are never part of a list or detail response: the app asks for one only when told to.
    method: "GET",
    pattern: new RegExp(`^/api/messages/${ID}/body$`),
    name: "messages.body",
    handler: async (ctx) => {
      const message = await getMessageAdmin(ctx.db, ctx.params[0]!);
      if (!message) throw notFound();
      return json(200, { untrusted_body: message.clean_text });
    },
  },

  {
    method: "POST",
    pattern: new RegExp(`^/api/messages/${ID}/unprocess$`),
    name: "messages.unprocess",
    handler: async (ctx) => {
      if (!(await markUnprocessed(ctx.db, ctx.params[0]!))) throw notFound();
      return json(200, { ok: true });
    },
  },

  {
    method: "PUT",
    pattern: new RegExp(`^/api/messages/${ID}/keep$`),
    name: "messages.keep",
    handler: async (ctx) => {
      const { keep } = KeepBody.parse(await readJson(ctx.request));
      if (!(await setKeep(ctx.db, ctx.params[0]!, keep))) throw notFound();
      return json(200, { keep });
    },
  },

  {
    method: "DELETE",
    pattern: new RegExp(`^/api/messages/${ID}$`),
    name: "messages.delete",
    handler: async (ctx) => {
      if (!(await deleteMessage(ctx.db, ctx.params[0]!))) throw notFound();
      return json(200, { ok: true });
    },
  },

  {
    method: "GET",
    pattern: new RegExp(`^/api/attachments/${ID}/download$`),
    name: "attachments.download",
    handler: async (ctx) => {
      const attachment = await getAttachmentAdmin(ctx.db, ctx.params[0]!);
      if (!attachment) throw new ApiFailure(404, "attachment not found");
      const object = await ctx.env.BUCKET.get(attachment.r2_key);
      if (!object) throw new ApiFailure(404, "the file is no longer stored");
      return new Response(object.body, {
        headers: {
          "content-type": attachment.content_type,
          "content-length": String(object.size),
          // The name was made safe at ingest; the extra replacement keeps a header from being broken regardless.
          "content-disposition": `attachment; filename="${attachment.filename.replace(/["\\\r\n]/g, "_")}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    },
  },
];

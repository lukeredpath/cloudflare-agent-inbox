const CRLF = "\r\n";

export const AUTH_PASS = (domain = "example.com") =>
  `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${domain} header.s=sig1 header.b=abc;${CRLF}` +
  `\tdmarc=pass header.from=${domain} policy.dmarc=none; spf=pass smtp.mailfrom=sender@${domain}`;
export const AUTH_NONE =
  "Authentication-Results: mx.cloudflare.net; dkim=none; dmarc=none header.from=example.com; spf=softfail smtp.mailfrom=sender@example.com";
export const AUTH_FORGED = "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.com header.s=sig1";
export const AUTH_OTHER_SERVER = "Authentication-Results: evil.example; dkim=pass header.d=example.com";

export interface EmlAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array | string;
  /** Marks the part as an embedded image referenced by cid. */
  contentId?: string;
}

export interface EmlOptions {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  /** Authentication-Results header lines, in order. Defaults to one passing header. */
  auth?: string[];
  attachments?: EmlAttachment[];
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/.{76}/g, "$&\r\n");
}

const textPart = (type: string, body: string) =>
  `Content-Type: ${type}; charset=utf-8${CRLF}Content-Transfer-Encoding: 8bit${CRLF}${CRLF}${body}`;

export function buildEml(o: EmlOptions = {}): Uint8Array {
  const headers = [
    "Received: from mail.example.org by mx.example.net",
    ...(o.auth ?? [AUTH_PASS()]),
    `From: Sender <${o.from ?? "sender@example.com"}>`,
    `To: ${o.to ?? "inbox@mail.example.com"}`,
    `Subject: ${o.subject ?? "Test message"}`,
    "MIME-Version: 1.0",
  ];

  let body: string;
  if (o.html !== undefined && o.text !== undefined) {
    body =
      `Content-Type: multipart/alternative; boundary=ALT${CRLF}${CRLF}` +
      `--ALT${CRLF}${textPart("text/plain", o.text)}${CRLF}--ALT${CRLF}${textPart("text/html", o.html)}${CRLF}--ALT--${CRLF}`;
  } else if (o.html !== undefined) {
    body = textPart("text/html", o.html);
  } else {
    body = textPart("text/plain", o.text ?? "Hello");
  }

  if (o.attachments?.length) {
    const parts = o.attachments.map((a) => {
      const bytes = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content;
      const disposition = a.contentId ? "inline" : "attachment";
      return (
        `--MIX${CRLF}Content-Type: ${a.contentType}; name="${a.filename}"${CRLF}` +
        `Content-Disposition: ${disposition}; filename="${a.filename}"${CRLF}` +
        (a.contentId ? `Content-ID: <${a.contentId}>${CRLF}` : "") +
        `Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64(bytes)}${CRLF}`
      );
    });
    body =
      `Content-Type: multipart/mixed; boundary=MIX${CRLF}${CRLF}--MIX${CRLF}${body}${CRLF}` + parts.join("") + `--MIX--${CRLF}`;
  }
  return new TextEncoder().encode(headers.join(CRLF) + CRLF + body);
}

/** A message/rfc822 attachment holding another message, as a manual "forward as attachment" produces. */
export function forwardedAttachment(inner: EmlOptions): EmlAttachment {
  return { filename: "forwarded.eml", contentType: "message/rfc822", content: buildEml({ ...inner, auth: [] }) };
}

export const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

export interface ArcOptions {
  forwarder?: string;
  /** Results recorded by the forwarder for the original hop (after its own `arc=pass`). */
  recorded?: string;
  /** Cloudflare's own Authentication-Results; defaults to a fully passing one. */
  cloudflare?: string;
  topSeal?: string;
  forwarderCv?: string;
  /** Authserv-id the forwarder recorded results under. */
  forwarderServer?: string;
  /** Extra header lines, e.g. unsigned hints a forwarder adds. */
  extra?: string[];
}

export const FORWARDED_ORIGIN = {
  from: "billing@billing.example.org",
  recorded:
    "arc=pass; dmarc=pass header.from=billing.example.org; dkim=none; spf=pass smtp.mailfrom=bounce@mail.billing.example.org",
};

/**
 * Header lines for a message forwarded by a mailbox provider's server-side rule, modelled on
 * the real structure: Cloudflare's header on top, then its own ARC set (i=3), the forwarder's
 * set (i=2) recording the original hop's verdicts, and the origin's (i=1). Unsigned hints
 * (X-Forward-Action) are added the way a forwarder does. Synthetic domains only.
 */
export function arcLines(o: ArcOptions = {}): string[] {
  const forwarder = o.forwarder ?? "forwarder.example.net";
  return [
    o.cloudflare ??
      "Authentication-Results: mx.cloudflare.net; dkim=none; dmarc=pass header.from=billing.example.org;" +
        ` spf=pass smtp.helo=relay.${forwarder}; spf=pass smtp.mailfrom=sender@example.com; arc=pass`,
    `ARC-Seal: i=3; a=rsa-sha256; s=cf; d=${o.topSeal ?? "cloudflare-email.net"}; cv=pass; b=AAAA`,
    "ARC-Message-Signature: i=3; a=rsa-sha256; d=cloudflare-email.net; s=cf; h=from:to:subject; bh=AAAA; b=AAAA",
    "ARC-Authentication-Results: i=3; mx.cloudflare.net; arc=pass",
    `ARC-Seal: i=2; a=rsa-sha256; s=arc1; d=${forwarder}; cv=${o.forwarderCv ?? "pass"}; b=BBBB`,
    `ARC-Message-Signature: i=2; a=rsa-sha256; d=${forwarder}; s=arc1; h=from:to:subject; bh=BBBB; b=BBBB`,
    `ARC-Authentication-Results: i=2; ${o.forwarderServer ?? `arc.${forwarder}`}; ${o.recorded ?? FORWARDED_ORIGIN.recorded}`,
    "ARC-Seal: i=1; a=rsa-sha256; s=orig; d=origin.example.org; cv=none; b=CCCC",
    "ARC-Message-Signature: i=1; a=rsa-sha256; d=origin.example.org; s=orig; h=from:to:subject; bh=CCCC; b=CCCC",
    "ARC-Authentication-Results: i=1; mx.origin.example.org; dkim=pass header.d=billing.example.org",
    "X-Forward-Action: FORWARD/inbox@mail.example.com",
    "Original-Recipient: rfc822;sender@example.com",
    ...(o.extra ?? []),
  ];
}

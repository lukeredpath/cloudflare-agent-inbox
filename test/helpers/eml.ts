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

# HTTP ingest

An optional endpoint that files a raw email into one lane over HTTPS, for a trusted program
(a mail rules engine, say) that already has the message and should not have to forward it by
email. It is off unless configured.

```
POST https://<ingest hostname>/ingest/lanes/<lane slug>
```

Getting a message in this way is meant to be as hard as the email path. A request must pass
Cloudflare Access with a service token **and** carry an HMAC signature made with a secret that
belongs to that one lane.

## Enabling it

1. In Cloudflare Zero Trust, create a **service token** for the program that will call the
   endpoint, and an Access application for the ingest hostname (a custom domain on your zone)
   whose only policy is a *Service Auth* rule allowing that token. Note the application's
   **Application Audience (AUD) tag**.
2. Set these build variables (the build refuses a partial set). The team domain is shared
   with the admin interface if you use both:

   | Variable | Meaning |
   | --- | --- |
   | `AGENT_INBOX_INGEST_HOSTNAME` | Custom domain for ingest; must differ from the other hostnames |
   | `AGENT_INBOX_ACCESS_TEAM_DOMAIN` | Your Access team domain, for example `team.cloudflareaccess.com` |
   | `AGENT_INBOX_INGEST_ACCESS_AUD` | The ingest Access application's audience tag |

3. Deploy (this applies the migration that adds the key tables).
4. Create the ingest key pair once: `npm run cli -- ingest-keys init`. The private key goes
   straight to the Worker as the `INGEST_PRIVATE_KEY` secret and is never printed.
5. Create a key for each lane that should accept messages, either on the lane's page in the
   [admin interface](admin.md) (**Ingest keys**, **New key**) or in your own terminal with
   `npm run cli -- ingest-keys create <lane>`. Either way the key id and secret are shown
   **once**. Store both with the caller, for example in a password manager and a Docker secret.

Until `INGEST_PRIVATE_KEY`, the team domain and the audience are all set, the ingest host
answers 503 to everything.

## Keys

- A key belongs to one lane and can only add messages to it. It cannot read, list or touch
  anything else.
- A lane can have two active keys at once, so a key can be replaced without downtime:
  create the new one, switch the caller over, then revoke the old one.
- Keys can be managed in the admin interface or the CLI; both use the same storage.
  - **Admin interface:** each lane's page has an **Ingest keys** panel listing the lane's keys
    (when each was created and last used, and which are revoked), with **New key** and
    **Revoke**. The panel also shows the lane's endpoint URL once ingest is configured. A new
    key's secret appears in a panel at the top of the page until you hide it; it lives only in
    the page's memory, so it is gone after a reload, and the API has no way to return it again.
    Creating and revoking are ordinary admin changes: same-origin JSON behind Cloudflare
    Access, logged by action name only, never with the key or secret.
  - **CLI:** `ingest-keys create <lane>`, `ingest-keys list` (every lane) and
    `ingest-keys revoke <id>`. `create` refuses to run with `--json` or piped output, so the
    secret only ever reaches a terminal.
- Secrets are never shown again after creation, by either.
- Deleting a lane revokes its keys.

HMAC needs the secret itself, so it cannot be stored as a hash. Each secret is encrypted
(ECDH P-256, HKDF-SHA-256, AES-256-GCM) to the Worker's ingest key pair: the public key is
kept in D1 so the admin interface and the CLI can create keys, and the private key is a Worker
secret, so only the ingest endpoint can read a secret back. Neither the admin interface, the
CLI nor anyone with read access to D1 can.
`ingest-keys init --replace` makes a new key pair and revokes every existing key.

## The request

| Part | Value |
| --- | --- |
| Body | The raw message, untouched, at most 25 MB (and within the lane's own size limit) |
| `Content-Type` | `message/rfc822` |
| `CF-Access-Client-Id`, `CF-Access-Client-Secret` | The service token |
| `X-Signature-Key-Id` | The key id (`aik_…`) |
| `X-Signature-Timestamp` | Unix time in seconds |
| `X-Signature` | `sha256=` followed by the lower-case hex HMAC-SHA256 of the string to sign, keyed with the secret's UTF-8 bytes |
| `Idempotency-Key` | Optional; accepted and ignored. Repeats are recognised from the message itself (below) |

The string to sign is four lines joined by `\n`, with no trailing newline:

```
<timestamp>
POST
/ingest/lanes/<lane slug>
<lower-case hex SHA-256 of the body>
```

Signing the path means a key for one lane cannot be replayed against another.

A sketch in TypeScript (Node 22):

```ts
import { createHash, createHmac } from "node:crypto";

const path = `/ingest/lanes/${lane}`;
const timestamp = String(Math.floor(Date.now() / 1000));
const bodyHash = createHash("sha256").update(raw).digest("hex");
const signature = createHmac("sha256", secret).update(`${timestamp}\nPOST\n${path}\n${bodyHash}`).digest("hex");

await fetch(`https://ingest.example.com${path}`, {
  method: "POST",
  headers: {
    "content-type": "message/rfc822",
    "cf-access-client-id": accessClientId,
    "cf-access-client-secret": accessClientSecret,
    "x-signature-key-id": keyId,
    "x-signature-timestamp": timestamp,
    "x-signature": `sha256=${signature}`,
  },
  body: raw,
});
```

## Checks, in order

1. Cloudflare Access rejects a request without a valid service token before the Worker runs.
   The Worker checks the Access token again and fails closed (403).
2. The key exists, is not revoked and belongs to the lane in the URL.
3. The timestamp is within 300 seconds of the Worker's clock, either way.
4. The signature matches, compared in constant time (`crypto.subtle.verify`).
5. Only signed requests count towards the rate limit of 60 a minute per key
   (`INGEST_LIMITER`).
6. The content type, the lane's state and size limit, and parsing: the body must be an email
   with a `From` and a `Message-ID`. Attachments must pass the lane's policy, exactly as for
   mail that arrives by email.

Every failure in steps 2 to 4 gets the same `401 {"error":"unauthorized"}`, so a caller
learns nothing about which check failed. The log line records which one (see
[operations.md](operations.md)).

## Responses

| Status | Body | Meaning |
| --- | --- | --- |
| `201` | `{"id": "…", "duplicate": false}` | Stored |
| `200` | `{"id": "…", "duplicate": true}` | Already stored: the same lane, `Message-ID` and body. Nothing new is stored |
| `401` | `{"error": "unauthorized"}` | Key, timestamp or signature failed |
| `403` | `{"error": "forbidden"}` | No valid Access token |
| `404`, `405` | | Not `POST /ingest/lanes/<slug>` |
| `409` | `{"error": "lane paused"}` | The lane is paused |
| `413` | `{"error": "too large"}` | Over 25 MB or the lane's limit |
| `415` | | Not `message/rfc822` |
| `422` | `{"error": "parse_error" \| "attachment_not_allowed"}` | Not a usable email, or an attachment the lane does not accept |
| `429` | `{"error": "rate limited"}` | Over 60 a minute for this key; retry after a minute |
| `503` | | Ingest is not configured, or Access's keys could not be fetched |

A repeat with the same `Message-ID` but a different body is stored as a new message.

## How stored messages differ

They are stored exactly as email-path messages are (raw message in R2, cleaned text and
attachments, transforms applied), and agents see them the same way. In D1 they are marked
`source = 'api'` with the key id, and their authentication summary reads `api key=<id>`.
The `From` header stands in for the envelope sender, since there is no SMTP envelope.

The original sender's DKIM signature survives, because the message is sent untouched, but
it is not checked yet.

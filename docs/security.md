# Security model

## What is trusted

- **The envelope sender and Cloudflare's own `Authentication-Results`.** A
  message is accepted only if its envelope sender is on the lane's allowlist
  *and* the first `Authentication-Results` header comes from `mx.cloudflare.net`
  and one of two paths holds. The visible `From` header is never trusted on its
  own, and neither are the unsigned hints forwarders add (`X-Apple-Action`,
  `Original-Recipient` and the like).

  **Path A, direct.** Cloudflare reports `dkim=pass` for a configured domain that
  matches the envelope sender's domain (or its parent), **and** `spf=pass` for that
  envelope sender. This is mail you compose or forward by hand: your mail provider
  signs it. Requiring both stops a signed message being replayed from another server,
  and stops an unrelated domain on the list vouching for your address. Only list a
  domain you control, never a shared mail provider's.

  **Path B, forwarded.** Server-side forwarding rules add no signature of their
  own, so path A can never pass for them. iCloud Mail is the example this was
  built for: its forwarding rules leave the message untouched, rewrite the
  envelope sender to the mailbox owner, and add an ARC set sealed by `icloud.com`
  recording how the original message authenticated on arrival. Mail you compose
  or forward by hand in an iCloud-backed mailbox is signed with your domain's
  DKIM key and passes path A, which is why only the automatic rules need path B.

  In general, path B relies on a *trusted forwarder* (for example your mailbox
  provider) that seals an ARC set recording how the original message
  authenticated when it arrived. It accepts a message when all of these hold:

  1. Cloudflare reports `arc=pass`, which covers the whole chain, including the
     forwarder's recorded results. The chain's cryptography is not re-checked here.
  2. Cloudflare reports `spf=pass` for the envelope sender, so a genuine
     ARC-sealed message cannot be replayed from somewhere else with a spoofed
     envelope sender.
  3. The topmost ARC set is Cloudflare's own, and the set beneath it (matched by
     its `i=` instance, never by header order) is sealed by a trusted forwarder,
     with `cv=pass`, or with `cv=none` when it is the first set in the chain (`i=1`),
     which is what RFC 8617 requires of a first set. Cloudflare's own set must be
     `cv=pass`, and it covers everything beneath it. Instances must be contiguous
     and unduplicated.
  4. The `ARC-Authentication-Results` for that instance exists exactly once. The
     forwarder's seal covers it, so nothing about the forwarder's server naming
     is assumed.
  5. The message has exactly one `From` header, its address is on the lane's
     `forwarded_from` list (an exact address, `*@domain` for that exact domain, or
     `*` for any), and the recorded results show one of that entry's
     required verdicts passing **aligned with the From domain**: `dmarc`
     (default, the strictest), `dkim`, or `spf`. A pass about some other domain
     does not count.

  No mail provider is named in the code. A forwarder works if it seals its own ARC
  set, records the original hop's verdicts in it, and sets the envelope sender to
  an address you allow. This path has been tested with synthetic messages only. A
  real provider's ARC headers have been inspected, but no message has yet been
  accepted through it on a real deployment.

  The From header must hold exactly one address; a list of mailboxes, a trailing
  comment or an unparsable header is refused. When several rules could match, only
  the most specific is used (exact, then domain, then `*`), so a failing exact rule
  never falls back to a wildcard. Wildcard rules (`*@domain`, `*`) must require
  `dmarc` and nothing else, and `*@<public suffix>` is refused.

  A `*` rule changes what the lane trusts: the Worker no longer checks that you
  chose the sender, only that the sender authenticated as itself. Anyone with a
  properly configured domain who can get mail into your forwarding rule can reach
  the lane, so the rule's own conditions are the real gate. Message content is
  still untrusted (see below).

  Path B is off unless the deployment lists trusted forwarders **and** the lane
  has `forwarded_from` entries. It trusts the forwarder's own record of the
  original hop, so only list a forwarder you would trust to vouch for senders.
- **Nothing in the message body or headers.** Subject, `From`, the sender of a
  message forwarded as an attachment, filenames and the body are all written by
  third parties. They are stored as data and returned to agents in fields whose
  names start with `untrusted`.

## Ingress

| Situation | Result |
| --- | --- |
| Unknown address, wrong host, wrong shape | dropped silently, logged in the probe bucket |
| Sender not allowed, failed or missing authentication | dropped silently, logged. When the envelope sender *was* allowed (a likely genuine forward), a size-capped excerpt of the authentication headers is kept with the log row to explain the failure |
| Paused lane, verified sender | rejected at SMTP (bounces to the sender), logged |
| Paused lane, anyone else | dropped silently, so the paused state is not visible |
| Too large, attachment not allowed, parse error | dropped silently, logged |
| Flood from unlisted senders over the rate limit | dropped before any database work, logged as `rate_limited` (not stored in the rejection log) |
| Storage failure after the sender was verified | rejected at SMTP, so a genuine forward is never lost silently |

Nothing rejected is stored beyond a headers-only log row (the full recipient is
never logged; the diagnostics excerpt holds authentication headers only, never a
body, at most 2,000 characters). The log is capped per bucket per day and purged after 30 days.
Attachment types are decided from the file's bytes, not its declared type.
Embedded images are discarded without being stored.

### Known limits of the sender check

- The lane address is the first gate: it is 160 random bits and never logged in
  full. Both paths rely on it staying secret, and SPF for the envelope sender is
  required on both, so a captured message cannot simply be replayed from elsewhere.
  Rotate the address (`lanes rotate`) if it leaks.
- Hidden-text removal in HTML (display:none, zero-size text and similar) is best
  effort. It does not catch every way of hiding text, so treat message text as
  untrusted whatever the sanitiser did.
- Mailbox providers may prepend tags such as `[Not Virus Scanned]` to subjects
  when they cannot scan an attachment. That edit happens after the original
  signature, which is one reason path B reads the provider's record instead of
  re-checking the original signature. A leading `[Not Virus Scanned]` is removed
  from the stored subject; the raw message is stored untouched.

## Cloudflare protections

Cloudflare's own features can sit in front of the Worker. Some are inherent, some you
add. Plan limits below are for the Free plan; check your own.

**Mail.** There is no WAF in front of SMTP. What exists:

- *Inherent:* Cloudflare's mail servers enforce the sender's DMARC policy and reject
  known-bad senders before a message reaches the Worker.
- *Rate limit (in this project):* the Worker uses Cloudflare's rate-limiting binding
  (`MAIL_LIMITER`, 20 per 10 seconds per location) for mail from senders that are not
  on the deployment's allowlist. Over the limit, mail is dropped before any database
  work and logged as `rate_limited`. Mail from a listed sender is never limited. It
  is approximate and per location, and a flood that spoofs a listed sender's address
  bypasses it (it must still pass authentication). The binding is optional; without
  it nothing is limited.

**Web (MCP and share hosts).** These hostnames are proxied, so zone features apply.
A single custom rule is enough to remove everything the Worker does not need to see:

```
(http.host eq "mcp.example.com"
   and not (http.request.method eq "POST"
            and http.request.uri.path eq "/mcp/agent"
            and (ip.src in {<ranges your agents call from>} or ip.geoip.country eq "GB")))
or (http.host eq "files.example.com"
   and not (http.request.method eq "GET" and starts_with(http.request.uri.path, "/s/")))
```

Action: Block. The first half lets only `POST /mcp/agent` through, and only from the
networks your agents use. The second lets only `GET /s/...` through; share links are
fetched by third-party services from arbitrary addresses, so they cannot be limited
by location. Blocked requests get a bare 403 that does not name the product.

Things to know:

- If the mail and MCP hostnames are the same, one rule still covers both: mail does not
  use HTTP.
- The Free plan allows 5 custom rules and a single rate-limiting rule for the whole
  zone, so check what is already used before adding more.
- Do **not** turn on Bot Fight Mode for a zone that also serves other API traffic: it is
  zone-wide, cannot be exempted by custom rules, and can challenge legitimate machine
  clients.
- Cloudflare Access in front of the MCP is not an option for clients that can only
  send a bearer token, such as Claude's custom connectors.
- Test after adding the rule: an expected request still reaches the Worker (a 401 for
  an unauthenticated MCP call, a 404 for an unknown link), and anything else gets a 403.

## Lanes and agents

- `list_messages` requires a lane name and nothing lists lanes, so an agent that shares a
  connection with others only reaches the lanes it was told about. This guards against
  accidents, not guessing: slugs are guessable, and the grant below is what enforces access.
  A lane that is not granted and one that does not exist get the same refusal.
- Lane scope is enforced in SQL on every agent call. A message or attachment
  outside the agent's grants is "not found".
- Agent tokens are 256 random bits, stored only as SHA-256 hashes, and revoked
  tokens stop working on the next call.
- The Worker has no admin endpoint. The CLI uses a scoped Cloudflare API token
  (D1 Edit and Workers Editor) held by the operator.
- The MCP exposes no deletion, no lane management and no file contents. Share
  links are opt-in per lane, last 15 minutes by default (60 at most), are
  served from their own hostname and never appear in logs or CLI output. A link
  stops working as soon as the agent that made it is revoked, loses the lane, or
  the lane stops being shareable. Who used a link, and which file, is logged.

## Transforms

A transform is reviewed code that a lane opts into; there are no user-supplied
scripts. `unzip` reads its password from a Worker secret named in the lane's
config. Secret names must start with `LANE_SECRET_`, so a lane cannot point a
transform at any other secret. Extraction is all or nothing, with limits on
entry count, total decompressed size (enforced while streaming), nested archives
and inner types. A failed transform never rejects the message: the attachment is
flagged with `transform_error`, visible in `lanes get` and to agents.

## The admin CLI

It prints metadata only. A message body is printed only with an explicit
`--show-body`, intended for a person reading it themselves. Untrusted fields are
stripped of terminal escape sequences and invisible characters before printing.
`agents create` refuses to print a token unless it has an interactive terminal.

## Limits of this design

This project does not try to detect malicious content. If an agent that reads a
lane can also take consequential actions (spend money, send messages, browse the
web), an attacker who can get mail through your allowlist can try to steer it.
Keep consuming agents narrowly scoped, and review what each lane's agents are
allowed to do before granting access.

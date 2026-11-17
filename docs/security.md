# Security model

## What is trusted

- **The envelope sender and Cloudflare's own `Authentication-Results`.** A
  message is accepted only if its envelope sender is on the lane's allowlist
  *and* the first `Authentication-Results` header comes from `mx.cloudflare.net`
  and shows `dkim=pass` for a configured domain. The visible `From` header is
  never trusted on its own.
- **Nothing in the message body or headers.** Subject, `From`, the sender of a
  message forwarded as an attachment, filenames and the body are all written by
  third parties. They are stored as data and returned to agents in fields whose
  names start with `untrusted`.

## Ingress

| Situation | Result |
| --- | --- |
| Unknown address, wrong host, wrong shape | dropped silently, logged in the probe bucket |
| Sender not allowed, failed or missing authentication | dropped silently, logged |
| Paused lane, verified sender | rejected at SMTP (bounces to the sender), logged |
| Paused lane, anyone else | dropped silently, so the paused state is not visible |
| Too large, attachment not allowed, parse error | dropped silently, logged |
| Storage failure after the sender was verified | rejected at SMTP, so a genuine forward is never lost silently |

Nothing rejected is stored beyond a headers-only log row (the full recipient is
never logged). The log is capped per bucket per day and purged after 30 days.
Attachment types are decided from the file's bytes, not its declared type.
Embedded images are discarded without being stored.

## Lanes and agents

- Lane scope is enforced in SQL on every agent call. A message or attachment
  outside the agent's grants is "not found".
- Agent tokens are 256 random bits, stored only as SHA-256 hashes, and revoked
  tokens stop working on the next call.
- The Worker has no admin endpoint. The CLI uses a scoped Cloudflare API token
  (D1 edit and Workers secrets edit) held by the operator.
- The MCP exposes no deletion, no lane management and no file contents. Share
  links are opt-in per lane, last 15 minutes by default (60 at most), are
  served from their own hostname and never appear in logs or CLI output.

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
`agents mint` refuses to print a token unless it has an interactive terminal.

## Limits of this design

This project does not try to detect malicious content. If an agent that reads a
lane can also take consequential actions (spend money, send messages, browse the
web), an attacker who can get mail through your allowlist can try to steer it.
Keep consuming agents narrowly scoped, and review what each lane's agents are
allowed to do before granting access.

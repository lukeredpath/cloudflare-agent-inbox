# Getting started

This walks you from nothing to a working inbox: a Worker on your Cloudflare
account that receives the emails you forward, files them into lanes, and lets an
agent read the lanes you grant it. Allow an hour or two the first time, most of
it waiting on DNS and clicking through dashboards.

Prefer to have an agent do the mechanical parts? See
[agent-setup.md](agent-setup.md): a prompt you can paste into an agent, and what
it can and cannot do for you.

Tick the boxes as you go. Steps marked **Verify** are checks that this guide
cannot do for you.

> **Unofficial.** Not affiliated with Cloudflare. Examples use `example.com`
> and made-up addresses; use your own values and keep them out of the repo.

## What you will end up with

```
you ─► forward an email ─► inbox+<token>@mail.example.com ─► Worker
                                                              │ checks it came from you
                                                              │ cleans it to plain text
                                                              ▼
                          agent ◄── MCP (bearer token) ◄── lane (D1 + R2)
```

- A **lane** is a kind of email that needs its own handling (receipts, invoices,
  notifications). Each lane has its own secret address and its own rules.
- An **agent** (a script, an assistant, a scheduled task) gets a bearer token
  and can read only the lanes you grant it.
- You manage everything with the `agent-inbox` command-line tool on your own
  machine. The Worker has no admin endpoint.

## Before you start

- [ ] A **Cloudflare account** with a domain whose DNS is on Cloudflare. Email
  Routing needs Cloudflare DNS.
- [ ] A **GitHub account**, and this repository forked or copied into it (keep
  it private until you have checked it contains nothing of yours).
- [ ] **Node.js 22** and npm 11 locally (`npx npm@11 ...` works without
  installing it).
- [ ] A mailbox you forward from (any provider), and an agent that can speak MCP
  over HTTP with a bearer token. Step 9 shows how to test with `curl` first.
- [ ] Somewhere safe for secrets: a password manager. You will handle one
  Cloudflare API token and one token per agent.

**Plans.** The defaults suit the Workers Free plan: zip archives are limited to 10
files and 10 MiB decompressed, and a message to 10 attachments. Email handlers
have tight CPU limits on Free, so a large or complex message may fail there; the
Paid plan raises the limits. See [deploy.md](deploy.md).

## 1. Get the code

```sh
git clone https://github.com/<you>/cloudflare-agent-inbox.git
cd cloudflare-agent-inbox
npx npm@11 install
npm test
npm run typecheck
git config core.hooksPath .githooks
```

- [ ] Tests and typecheck pass.

Optional but recommended: make a file called `.pii-denylist` (git-ignored) with
one personal value per line (your domain, your address). The pre-commit hook and
`npm run pii-scan` then stop you committing them by accident.

## 2. Choose your hostnames

You need three, all on your Cloudflare zone. They are configuration, never
committed.

| Purpose | Example | Notes |
| --- | --- | --- |
| Mail | `mail.example.com` | Receives forwarded mail. A subdomain is fine. |
| MCP | `mcp.example.com` | Where agents connect. |
| Share links | `files.example.com` | Serves short-lived download links. Must differ from the MCP host. |

Write yours here (and nowhere in the repo):

- Mail: `________`   MCP: `________`   Share: `________`

## 3. Create the Worker and deploy

Deployment uses **Cloudflare Workers Builds**, connected to your GitHub repo. No
Cloudflare credentials are stored in GitHub.

- [ ] In the Cloudflare dashboard, create a Worker and connect it to your repo.
  The Worker's name is also used as the D1 database and R2 bucket name.
- [ ] Under the Worker's Settings, Build, add these **build variables**, ticking
  the secret option so they are masked in logs:

| Variable | Value |
| --- | --- |
| `AGENT_INBOX_WORKER_NAME` | the Worker's name |
| `AGENT_INBOX_MAIL_HOSTNAME` | your mail hostname |
| `AGENT_INBOX_MCP_HOSTNAME` | your MCP hostname |
| `AGENT_INBOX_SHARE_HOSTNAME` | your share hostname |
| `AGENT_INBOX_DEFAULT_ALLOWED_SENDERS` | the address(es) you forward from, comma-separated |
| `AGENT_INBOX_ALLOWED_DKIM_DOMAINS` | the domain your mail provider signs your own mail with |
| `AGENT_INBOX_TRUSTED_ARC_FORWARDERS` | your mailbox provider's domain if you will use its server-side forwarding rules (step 8); otherwise any domain you do not use |

- [ ] Build command: `npm run build`.
- [ ] **First deploy only:** deploy command `npx wrangler deploy`. This
  creates the D1 database and R2 bucket. Trigger a build and wait for it to pass.
- [ ] Now change the deploy command to `npm run deploy` (it applies database
  migrations, then deploys) and trigger another build.
- [ ] In the Worker's settings, check the MCP and share hostnames are attached as
  custom domains.

**Verify:** the build log shows the rendered bindings (database, bucket,
variables). If the first `npm run deploy` cannot find the database, the first
deploy above did not complete.

## 4. Route email to the Worker

Lane addresses look like `inbox+<token>@mail.example.com`. Cloudflare only allows
catch-all rules on the apex domain, so this uses *subaddressing* with a single rule.

- [ ] Email Routing: add your mail hostname as a subdomain of the zone (skip if it
  is the apex).
- [ ] Settings: turn on **subaddressing**.
- [ ] Add one literal rule: `inbox@<your mail hostname>` > Send to a Worker > your Worker.

**Verify:** subaddressing on a subdomain delivers to the Worker. From any mailbox,
send a message to `inbox+test@<your mail hostname>`. After step 5, run
`npm run cli -- rejections list`: you should see an `unknown_address` row whose
recipient hint starts `inbox+t`. If nothing arrives at all, stop: the address
form needs another look.

## 5. Set up the command-line tool

The CLI talks to Cloudflare's API directly, with a **scoped token you hold**, not
your full login.

- [ ] Create an API token (My Profile, API Tokens) with only the permissions it
  needs on your account: **D1 Edit** and **Workers Scripts Edit** (for secrets).
  The dashboard's names may differ slightly.
- [ ] Store it in your password manager. Never put it in the repo.
- [ ] Export, in your terminal (or load them with your password manager's CLI):

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...                 # on your zone's overview page
export AGENT_INBOX_WORKER_NAME=...               # the Worker's name
export AGENT_INBOX_MAIL_HOSTNAME=mail.example.com
```

- [ ] `npm run cli -- lanes list` prints `No lanes yet.` (that proves the
  token, the account, the database lookup and the migration all work).

## 6. Create your first lane

```sh
npm run cli -- lanes create receipts --description "Shop receipts"
```

It prints the lane's **address**, `inbox+<token>@mail.example.com`. That address
is the lane's key: anyone who has it can try to send to it, so treat it like a
password. A text-only lane accepts no attachments.

- [ ] Try it without real mail:

```sh
npm run cli -- messages inject-test receipts --subject "Test" --text "Total 3.50 GBP"
npm run cli -- messages list
npm run cli -- lanes get receipts
```

`messages list` prints metadata only. Message bodies appear only with
`messages get <id> --show-body`, which you run yourself.

## 7. Give an agent access

- [ ] **In your own terminal** (it refuses to run anywhere a tool could capture the
  output):

```sh
npm run cli -- agents mint my-agent       # prints the token once: save it now
npm run cli -- agents grant my-agent receipts
```

Only a hash is stored, so a lost token means minting a new one
(`agents revoke my-agent --yes` kills the old one).

- [ ] Smoke-test the MCP with `curl` (replace the host and token):

```sh
curl -sS https://mcp.example.com/mcp/agent \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should see four tools: `list_messages`, `get_message`, `create_share_link`,
`mark_processed`. Without a valid token you get `401`.

- [ ] Connect your agent: Streamable HTTP, URL `https://mcp.example.com/mcp/agent`,
  header `Authorization: Bearer <token>`. Ask it to list messages; it should see
  your test message, with `is_test: true`.

**Before you let an agent read real mail, read the "Safety" section below.**

## 8. Forward real mail

How mail reaches the lane decides how the Worker can tell it came from you. There
are two ways; pick per lane.

**A. Compose or forward by hand.** Your mail provider signs it with your domain's
DKIM key, and the Worker checks that signature (Cloudflare verifies it). Set
`AGENT_INBOX_ALLOWED_DKIM_DOMAINS` to your domain. This works out of the box.

**B. A server-side forwarding rule.** Many providers forward without adding any
signature of their own, so path A can never pass. Instead the provider records,
in a signed ARC set, whether the original sender authenticated when it arrived,
and the lane can trust that record:

```sh
npm run cli -- lanes update receipts --forwarded-from orders@shop.example.net
```

- The provider's domain must be in `AGENT_INBOX_TRUSTED_ARC_FORWARDERS`.
- The default requirement is a DMARC pass for the original sender, aligned with
  its From domain. Loosen to `dkim` or `spf` per sender only after looking at what
  the provider records: `--forwarded-from orders@shop.example.net=dmarc,spf`.
- The envelope sender must still be one of your allowed senders: forwarding rules
  rewrite it to the mailbox owner.
- The code names no mail provider: the forwarder is whatever you list. It works
  with any forwarder that does all three of these, which you can check in a
  forwarded message's headers:
  1. adds an **ARC set sealed by its own domain** (`ARC-Seal: ...; d=<forwarder>`),
  2. records the original hop's results in that set's `ARC-Authentication-Results`
     (`dmarc=pass header.from=...`), and
  3. sets the **envelope sender to an address you allow**. Rules that keep the
     original sender, or rewrite it to a different address for every message
     (SRS), will not match an allowlist.
- Only iCloud Mail has been tested against real forwards. Other providers should
  work if they meet the three points; if one does not,
  `rejections list --diagnostics` shows what it sent.

Then:

- [ ] In your mail provider, create the rule or send one test forward to the lane's
  address.
- [ ] `npm run cli -- messages list` shows it, or
  `npm run cli -- rejections list --diagnostics` explains why not (see
  "Troubleshooting").

## 9. Lanes with attachments

Attachments are refused by default. A lane can allow types and run a transform,
for example unzipping a password-protected archive with a secret scoped to that
lane. See [lanes.md](lanes.md). In short:

```sh
npm run cli -- secrets set LANE_SECRET_STATEMENTS      # hidden prompt
npm run cli -- lanes create statements --shareable \
  --unzip-secret LANE_SECRET_STATEMENTS --inner-type application/pdf
```

Check `lanes get <slug>` after the first real message: it lists any transform
failures with the reason.

## Safety

Email bodies are written by third parties. This project keeps risk down by being
strict about who can get mail in and what an agent can do, not by judging content.

- [ ] The agent can only do what its own tools allow. Do not give an agent that
  reads email the ability to spend money, send messages, or browse the web unless
  you are comfortable with an attacker steering it.
- [ ] Grant each agent only the lanes it needs.
- [ ] Mint tokens yourself, in a terminal, and store them in a password manager.
- [ ] Never pass `--yes` or `--show-body` from automation.
- [ ] Read [security.md](security.md).

## Troubleshooting

`npm run cli -- rejections list` shows why mail did not arrive. Nothing rejected
is stored beyond headers.

| Reason | Meaning | Fix |
| --- | --- | --- |
| `unknown_address` | the address does not match a lane (wrong host, wrong shape, or rotated) | re-copy the address from `lanes get`; check the Email Routing rule |
| `sender_not_allowed` | the envelope sender is not on the lane's list | add it with `--allowed-sender`, or set `AGENT_INBOX_DEFAULT_ALLOWED_SENDERS`. Forwarding rules rewrite the envelope sender, so check what it became |
| `auth_failed` | the sender passed, but authentication did not | run `rejections list --diagnostics`. The detail says which path failed: `direct:` (no DKIM pass for an allowed domain, typical for rule-based forwards) or `forwarded:` (for example no `arc=pass`, forwarder not trusted, no aligned verdict) |
| `lane_paused` | you paused the lane; your own forward bounces so you notice | `lanes resume <slug>` |
| `too_large` | over the lane's message limit | `lanes update --max-bytes` |
| `attachment_not_allowed` | a type, size or count the lane does not accept (judged by the file's real type) | `--allow-type`, `--max-attachment-bytes` |
| `parse_error` | the message could not be read | forward it again as a plain message |

Other symptoms:

- **A message arrived but a file is missing or flagged**: `lanes get <slug>` lists
  transform failures (wrong password, a nested archive, an unexpected inner file,
  too large when decompressed).
- **The agent gets `401`**: wrong or revoked token, or the wrong hostname (the
  MCP host, not the share host).
- **A share link gives 404**: it expired (15 minutes by default, 60 at most), or
  the lane is not `--shareable`.
- **The CLI says variables are missing**: step 5 lists the four it needs.

## Day-to-day

```sh
npm run cli -- lanes list                       # status, address, counts
npm run cli -- lanes pause receipts             # verified forwards bounce so you notice
npm run cli -- lanes rotate receipts            # new address; the old one stops at once
npm run cli -- agents list
npm run cli -- agents revoke my-agent           # asks to confirm
npm run cli -- messages mark-unprocessed <id>   # hand a message back to an agent
npm run cli -- messages keep <id>               # exempt from retention
npm run cli -- messages inject-test receipts    # test an agent without real mail
```

Messages are purged after the lane's retention (90 days by default) by a daily
job. Updating is a normal `git pull` and push: Workers Builds redeploys and
applies new migrations.

# cloudflare-agent-inbox

A Cloudflare Worker that files forwarded emails into **lanes**, which AI agents
read through a narrow, mostly read-only MCP server. A separate admin CLI manages
lanes, agent tokens and secrets.

> **Unofficial.** This project is not affiliated with, endorsed by, or
> sponsored by Cloudflare. It runs on Cloudflare's developer platform and uses
> the name descriptively.

You forward chosen emails (receipts, invoices, notifications) from your own
mailbox to a lane's unguessable address. The Worker checks that the mail really
came from you, turns it into clean plain text, stores the original, and makes it
available to the agents you granted that lane, and nobody else.

## How it works

```
forwarded mail ─► Email Routing ─► email() handler
   1. address token → lane          unknown → drop silently
   2. sender + DKIM checks          fail    → drop silently
   3. lane paused                   verified sender → bounce (so you notice)
   4. size and attachment policy    fail    → drop silently
      (every rejection is logged headers-only, capped per day)
   5. clean text → D1; raw message and attachments → R2
   6. the lane's attachment transforms (e.g. unzip)

fetch() handler
   MCP host    /mcp/agent    bearer tokens, scoped to granted lanes
   share host  /s/<token>    short-lived download links

scheduled() ─► retention purge, expired links, old rejections

agent-inbox CLI (your machine) ─► Cloudflare API: D1 and Workers secrets
   (there is no admin route on the Worker)
```

- **Lanes are the unit of policy.** Each has its own address, allowed senders,
  attachment rules, transforms, size and retention limits.
- **Sender checks** accept mail you compose or forward by hand (DKIM for your
  domain) and, per lane, mail your provider forwards by a server-side rule
  (the provider's ARC record of the original sender). See
  [docs/security.md](docs/security.md).
- **Addresses** look like `inbox+<token>@<mail hostname>`. The token is 160
  random bits. Email Routing needs a single literal rule for
  `inbox@<mail hostname>`, with subaddressing enabled.
- **No AI in the pipeline.** Conversion to text is deterministic: HTML is
  stripped (including hidden content), zero-width and bidi characters are
  removed, text is NFKC-normalised, links become `text (domain)`.
- **Agents** get a bearer token and four tools: `list_messages`, `get_message`,
  `create_share_link` and `mark_processed`. Body text and other third-party
  fields come back under names starting `untrusted`.

**New here?** Follow [docs/getting-started.md](docs/getting-started.md), or
paste the [agent-guided setup prompt](docs/agent-setup.md) into an agent.

See [docs/security.md](docs/security.md) for the threat model,
[docs/lanes.md](docs/lanes.md) for lane recipes and
[docs/deploy.md](docs/deploy.md) for deployment.

## Quick start

```sh
npx npm@11 install
export CLOUDFLARE_API_TOKEN=...           # scoped: D1 edit and Workers secrets edit
export CLOUDFLARE_ACCOUNT_ID=...
export AGENT_INBOX_WORKER_NAME=...        # also the D1 database name
export AGENT_INBOX_MAIL_HOSTNAME=mail.example.com

npm run cli -- lanes create receipts --description "Shop receipts"
npm run cli -- agents mint my-agent       # interactive terminals only; prints the token once
npm run cli -- agents grant my-agent receipts
npm run cli -- messages inject-test receipts --text "Total 3.50 GBP"
```

`lanes create` prints the lane's address; point your mail rule at it.

## CLI

`npm run cli -- <command>`. Output is human-readable, or JSON with `--json`.
It prints metadata only; message bodies need `messages get <id> --show-body`.

| Command | Does |
| --- | --- |
| `lanes create\|list\|get\|update\|pause\|resume\|delete\|rotate` | manage lanes and their addresses |
| `agents mint\|list\|grant\|ungrant\|revoke` | manage agent tokens and what they can read |
| `secrets set LANE_SECRET_NAME` | set a Worker secret; the value is read from the terminal or stdin |
| `messages list\|get\|mark-unprocessed\|keep\|delete\|inject-test` | inspect and fix messages |
| `rejections list` | see what was rejected, and why |

Destructive commands (`lanes delete`, `lanes rotate`, `agents revoke`,
`messages delete`) ask for confirmation, or refuse in a non-interactive
session unless `--yes` is passed. Automation should not pass `--yes`.
`agents mint` refuses to run unless it has a terminal, so a token is never
captured by a tool or transcript.

## Configuration

Deployment values (hostnames, allowed senders, DKIM domains) are never
committed. `wrangler.example.jsonc` is a template; the real config is rendered at
deploy time from environment variables (see `.env.example`). You deploy with
`npm run deploy` from a clone, with no fork needed; Workers Builds is an optional
alternative. See [docs/deploy.md](docs/deploy.md).

Examples in this repository use `example.com` and made-up senders only.

## Threat model (summary)

Email bodies are untrusted data written by third parties. This project keeps
risk down with tight ingress control, per-lane scoping and a minimal agent
surface, not by filtering content. **Safety therefore also depends on what the
consuming agent is allowed to do**: give an agent that reads email only the
capabilities you would be comfortable with an attacker steering.

## Development

```sh
npx npm@11 install      # npm 10 can hit a peer-dependency bug with Vitest
npm test                # Vitest inside the Workers runtime
npm run typecheck
git config core.hooksPath .githooks   # enable the pre-commit scans
```

The pre-commit hook scans for personal values using a denylist you keep
outside the repository (`.pii-denylist`, which is git-ignored, or
`~/.config/agent-inbox/denylist.txt`; one term per line). `npm run pii-scan --
--history` scans every commit. CI runs
[gitleaks](https://github.com/gitleaks/gitleaks) on every push.

## Licence

MIT. See [LICENSE](LICENSE).

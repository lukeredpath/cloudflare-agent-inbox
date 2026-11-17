# Deploying with Workers Builds

Deployment is handled by Cloudflare Workers Builds, connected to this
repository. No Cloudflare credentials are stored in GitHub.

## How deployment values reach the build

The repository contains only `wrangler.example.jsonc`, a template whose
angle-bracket tokens are placeholders. At build time `npm run render-config`
fills them in from build variables and writes:

- `dist/wrangler.jsonc`: the real config (git-ignored).
- `.wrangler/deploy/config.json`: a redirect that makes a plain
  `wrangler deploy` use the rendered file.

Build variables are build-only and are not exposed to the Worker at runtime;
the rendered config is what puts values into the Worker's `vars`.

## Build variables

Set these under the Worker's Settings > Build > Build variables and secrets.
Mark them as secrets so they are masked in build logs.

| Variable | Meaning |
| --- | --- |
| `AGENT_INBOX_WORKER_NAME` | Worker name; also used as the D1 database and R2 bucket name |
| `AGENT_INBOX_MAIL_HOSTNAME` | Hostname that receives lane mail |
| `AGENT_INBOX_MCP_HOSTNAME` | Custom domain serving the agent MCP |
| `AGENT_INBOX_SHARE_HOSTNAME` | Custom domain serving share links |
| `AGENT_INBOX_DEFAULT_ALLOWED_SENDERS` | Comma-separated envelope senders allowed by default |
| `AGENT_INBOX_ALLOWED_DKIM_DOMAINS` | Comma-separated domains whose DKIM pass is required |

Values may contain letters, digits and `. , @ + : / -` only.

## Commands

- Build command: `npm test && npm run render-config`
- Deploy command: `npx wrangler deploy` (D1 migrations are added to this
  command when the schema lands: `wrangler d1 migrations apply ... --remote`
  first, then `wrangler deploy`).

## Email Routing

Catch-all rules are only available on the apex domain, so lane addresses use
subaddressing: `inbox+<token>@<mail hostname>`. Enable subaddressing in Email
Routing settings and add one literal rule for `inbox@<mail hostname>` that
sends to this Worker.

## Verified behaviour

_To be filled in at the first deployment: whether Workers Builds follows the
redirected config, and whether subaddressing works on a subdomain._

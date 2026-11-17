# Deploying

There are two ways to deploy. Both use the same settings and render the same config.
No Cloudflare credentials are ever stored in GitHub.

- **Local (default):** `npm run deploy` from a clone, with a deploy token in your
  environment. No fork or GitHub account needed. See
  [getting-started.md](getting-started.md#3-deploy).
- **Workers Builds (optional):** deploy on push from a repository you connect. This
  needs your own copy of the repo.

## How deployment values reach the build

The repository contains only `wrangler.example.jsonc`, a template whose
angle-bracket tokens are placeholders. At deploy or build time `npm run render-config`
fills them in from environment variables (or a git-ignored `.env.deploy`; see `.env.example`) and writes:

- `dist/wrangler.jsonc`: the real config (git-ignored). Relative paths in it are
  already adjusted for its location.
- `.wrangler/deploy/config.json`: a redirect that makes a plain
  `wrangler deploy` use the rendered file.

With Workers Builds, the variables are build variables, which are build-only and
not exposed to the Worker at runtime; the rendered config is what puts values into
the Worker's `vars`.

## Deployment variables

Locally, set these in your environment or a git-ignored `.env.deploy` (see `.env.example`;
a 1Password Environment mounted at that path works well).
With Workers Builds, set them under the Worker's Settings > Build > Build variables
and secrets, marked as secrets so they are masked in build logs.

| Variable | Meaning |
| --- | --- |
| `AGENT_INBOX_WORKER_NAME` | Worker name; also used as the D1 database and R2 bucket name |
| `AGENT_INBOX_MAIL_HOSTNAME` | Hostname that receives lane mail |
| `AGENT_INBOX_MCP_HOSTNAME` | Custom domain serving the agent MCP |
| `AGENT_INBOX_SHARE_HOSTNAME` | Custom domain serving share links |
| `AGENT_INBOX_DEFAULT_ALLOWED_SENDERS` | Comma-separated envelope senders allowed by default |
| `AGENT_INBOX_ALLOWED_DKIM_DOMAINS` | Comma-separated domains whose DKIM pass is accepted (direct mail you send or forward by hand) |
| `AGENT_INBOX_TRUSTED_ARC_FORWARDERS` | Comma-separated forwarders (for example your mailbox provider's domain) whose ARC record of the original sender is trusted. Lanes opt in with `--forwarded-from`; see [security.md](security.md) |

Values may contain letters, digits and `. , @ + : / -` only. The MCP and share
hostnames must differ from each other.

## Commands

- **Local:** `npm run deploy`. It renders the config, then orders the steps by whether
  the D1 database exists (`wrangler d1 list`): on a fresh account it deploys first,
  which provisions D1 and R2, then migrates; otherwise it migrates first, then
  deploys. `wrangler d1 migrations apply` does not follow the redirect file, so the
  migrate step passes the rendered config explicitly with `-c`.
- **Workers Builds:** build command `npm run build` (runs the tests, then renders
  the config), deploy command `npm run deploy`. If the build token cannot list
  databases the script assumes the database exists, so on a fresh account run
  `npx wrangler deploy` once as the deploy command, then switch back.

## Email Routing

Catch-all rules are only available on the apex domain, so lane addresses use
subaddressing: `inbox+<token>@<mail hostname>`.

1. Enable subaddressing in Email Routing settings.
2. Add the mail hostname as a subdomain of the zone if it is not the apex.
3. Add one literal rule for `inbox@<mail hostname>` that sends to this Worker.

## Runtime configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `MAIL_HOSTNAME`, `MCP_HOSTNAME`, `SHARE_HOSTNAME` | variable | rendered from the build variables above |
| `DEFAULT_ALLOWED_SENDERS`, `ALLOWED_DKIM_DOMAINS`, `TRUSTED_ARC_FORWARDERS` | variable | rendered from the build variables above |
| `MAX_REJECTED_PER_DAY` | variable, optional | per-bucket cap on logged rejections (default 50) |
| `LANE_SECRET_*` | secret | passwords for lane transforms, set with `secrets set` |

## The CLI's credentials

The CLI uses a scoped Cloudflare API token passed as `AGENT_INBOX_CLI_API_TOKEN`
(or `CLOUDFLARE_API_TOKEN` if that is not set)
(for example from a secrets manager): Workers Editor (for secrets) and D1 Edit only. Do not use a full `wrangler login`, and never store it in the
repository. It also needs `CLOUDFLARE_ACCOUNT_ID`, `AGENT_INBOX_WORKER_NAME` and
`AGENT_INBOX_MAIL_HOSTNAME`.

## Limits on the Workers Free plan

Email handlers have tight CPU and subrequest budgets on the Free plan, so the
defaults are conservative: zip archives are limited to 10 files and 10 MiB
decompressed, a message to 10 attachments and 30 stored files, and the purge
works through at most 50 deleted messages per run. Large or complex messages may
exceed the CPU limit on Free; the Paid plan raises these limits.

## Verifying a new deployment

- Workers Builds follows the redirected config (a deploy shows the rendered
  bindings), and migrations apply with the explicit `-c` path.
- Subaddressing preserves the `+token` part in the recipient: send a mail to
  `inbox+test@<mail hostname>` and check `rejections list` shows an
  `unknown_address` entry whose recipient hint starts `inbox+t`.
- `npm run cli -- lanes create ...` prints an address, and a forwarded message
  appears in `messages list`.

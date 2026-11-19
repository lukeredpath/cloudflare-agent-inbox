# Admin interface

An optional web interface for the things the CLI does: lanes, messages, agents and the
rejection log. It is served by the same Worker on its own hostname and is **off unless you
configure it**. Nothing changes for a deployment that does not.

## What it does

- **Overview:** every lane with its counts, and what needs attention: transform failures,
  paused lanes and recent rejections.
- **Lanes:** create, edit (every setting, including forwarded-from rules with a list editor
  and bulk paste), pause and resume, grant and ungrant agents, rotate the address, delete.
  The address is masked until you reveal it, and active share links are listed without the
  links themselves.
- **Messages:** filter by lane and status, search the loaded list, and open one to see its
  envelope, attachments (with download) and transform errors. Mark it unprocessed, keep it
  or delete it.
- **Agents:** create (the token is shown once, kept only in memory until you dismiss it),
  and revoke.
- **Rejections:** the log, with an optional diagnostics view.
- A command palette (`⌘K`), keyboard shortcuts (`?`), light and dark themes, and a layout
  that works on a phone.

`secrets set` and `messages inject-test` stay in the CLI: setting a Worker secret needs a
Cloudflare API token that the Worker should not hold.

## Handling untrusted content

Subjects, senders, bodies, filenames and error text come from email, so the interface treats
them as hostile:

- They are shown only as text, in a marked amber block or chip, never as markup. The app
  contains no code that sets HTML from data, and the content security policy forbids inline
  script, so a message cannot run anything.
- The API names every such field `untrusted_*`, the same rule as the agent-facing MCP.
- Message bodies are never part of a list or detail response. A body is fetched only when
  you press "Show body".
- Agent tokens and full lane addresses come back only from the request that creates or
  reveals them, and are not stored in the browser.

## Put it behind Cloudflare Access

The interface has no sign-in of its own. Cloudflare Access is the sign-in, and its policy
decides who may use the console. That policy is yours to choose; this project does not
encode one. A reasonable starting point for a single operator:

- a self-hosted application on the admin hostname, covering the whole hostname;
- one Allow policy naming only you, using an identity provider that enforces MFA;
- a short session duration, so a stolen laptop or cookie does not stay useful;
- no bypass or "everyone" policies, and no service tokens unless you need them.

## Enabling it

1. Create the Access application for the admin hostname (a custom domain on your zone) and
   its policy.
2. From the application, note its **Application Audience (AUD) tag**. Your team domain is
   the `<name>.cloudflareaccess.com` hostname shown under Zero Trust settings.
3. Set all three build variables (all or none; the build refuses a partial set):

   | Variable | Meaning |
   | --- | --- |
   | `AGENT_INBOX_ADMIN_HOSTNAME` | Custom domain for the admin interface; must differ from the other hostnames |
   | `AGENT_INBOX_ACCESS_TEAM_DOMAIN` | Your Access team domain, for example `team.cloudflareaccess.com` |
   | `AGENT_INBOX_ACCESS_AUD` | The Access application's audience tag |

4. Deploy. `npm run deploy` and `npm run build` build the admin app first.

## What the Worker enforces

The Worker does not decide who is allowed in. It refuses any request that did not pass
through the Access application you configured, so a mistake in Access (an unprotected
hostname, a policy edited by accident) does not leave the console open.

- Every request on the admin host, including the app's own files, must carry a valid
  `Cf-Access-Jwt-Assertion`: RS256, signed by a key from your team's certs endpoint, with the
  configured issuer and audience, and within its validity window. The Access cookie and
  identity headers are never trusted on their own.
- Without all three settings the host answers 503 and serves nothing.
- Changes to data must be JSON sent from the interface's own origin, which stops other
  sites from driving it through your signed-in browser.
- The page is served with a strict content security policy: scripts and styles only from
  the same origin, no framing, no referrer.
- Text that came from email is only ever rendered as text, and message bodies are
  fetched only when you ask for one.
- Logs record outcomes, never identities, addresses or content.

The Worker does not check which user signed in beyond what Access already decided, so keep
the Access policy as narrow as you would any admin console.

## Local development

```sh
npm run dev              # starts everything; seeds an empty local database
npm run dev -- --reseed  # throws the local data away and seeds it again
```

- **http://localhost:5173** is the app with hot reload. It proxies `/api` to the local Worker.
- **http://localhost:8799** is the same Worker serving the built app, with the production
  content security policy. Set `DEV_WORKER_PORT` if that port is taken.

This runs the real Worker, including the real Access check, against a local D1 and R2 holding
synthetic data (`dev/seed.sql`). `src/dev/worker.ts` stands in for Cloudflare Access: it signs
a token with a throwaway key for requests to `localhost` and serves the matching public key.
It is only used by `wrangler.dev.jsonc` and is never part of a deployment. Attachment files
are not stored locally, so downloads of the seeded attachments will not work.

## Not yet verified on a live deployment

The Access check is tested against tokens signed in the test suite and by the local stand-in,
not against a real Cloudflare Access application. On a first deployment, check that the
interface loads, that a request without Access (for example from a different hostname that
points at the same Worker) is refused, and that signing out and back in works.

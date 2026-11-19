# Admin interface (in development)

An optional web interface for the things the CLI does: lanes, messages, agents and the
rejection log. It is served by the same Worker on its own hostname and is **off unless you
configure it**. Nothing changes for a deployment that does not.

**Status:** the Worker side is in place (the Access check, a JSON API skeleton, and serving
the built app). The app itself is a placeholder that lists lanes; the real screens are still
to come. Treat this page as the contract the finished interface will keep.

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

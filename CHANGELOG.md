# Changelog

Releases are 0.x while the project is experimental: any release can contain breaking
changes. Each one is listed here.

## Unreleased

### Added

- An optional admin interface, served by the Worker on its own hostname behind Cloudflare
  Access (`docs/admin.md`): an overview with what needs attention, lanes (create, edit, pause,
  grant, rotate, delete), messages (with attachment download), agents (the token is shown
  once) and the rejection log, with a command palette, keyboard shortcuts and light and dark
  themes. It covers the CLI except `secrets set` and `messages inject-test`.
- The Worker verifies the Access token on every request and fails closed, sends a strict
  content security policy, and requires same-origin JSON for changes. Email content is shown
  only as text, the API names it `untrusted_*`, and bodies are fetched only on request. The
  app is a Preact single-page app built with Vite and served as static assets.
- Optional build variables: `AGENT_INBOX_ADMIN_HOSTNAME`, `AGENT_INBOX_ACCESS_TEAM_DOMAIN` and
  `AGENT_INBOX_ACCESS_AUD`, set together or not at all. Without them nothing is served on a new
  hostname.

- `npm run dev` runs the admin interface locally with hot reload, a local D1 and R2 holding
  synthetic data, and a stand-in for Access that never ships (`docs/admin.md`).

### Changed

- `npm run build` and `npm run deploy` build the admin app first, and the rendered config now
  includes an `assets` section. The build refuses an admin hostname that repeats the MCP,
  share or mail hostname, and an MCP hostname that repeats the share one. The mail hostname
  may still be the same as the MCP or share hostname.

## 0.2.0 (2026-11-19)

### Added

- `forwarded_from` accepts `*@domain` (exactly that domain, not subdomains) and `*`
  (any From address). Wildcards must require exactly `dmarc`, may not be a public
  suffix, and each pattern may appear once per lane. A lane may hold up to 100 rules
  (was 10). The most specific rule for the From address is the only one tried: an
  exact address, then a domain, then `*`.

### Fixed

- Mail forwarded by a provider whose ARC set is the first in the chain (`i=1`,
  `cv=none`, as RFC 8617 requires) was always rejected as "forwarder's ARC set did
  not validate". The first set is now accepted when Cloudflare's own set validates.
  Cloudflare's set must now itself be `cv=pass`.

### Changed

- The From header must contain exactly one address on the forwarded path. A list of
  mailboxes, a trailing comment, or an unquoted display name containing `,` or `@` is
  refused, and a quoted display name that contains an address is read as the real
  address after it. The sender stored with a message is that same address.
- Forwarded rules saved by an earlier version are checked again when read. One that no
  longer validates, or repeats an earlier pattern, is ignored. A wildcard rule is only
  ever matched on `dmarc`.

## 0.1.0 (2026-11-17)

The first release.

### What is in it

- A Worker that receives forwarded mail through Cloudflare Email Routing and files it
  into lanes, each with its own secret address and rules.
- Two ways for mail to prove it came from you: your mail provider's DKIM signature on
  mail you send or forward by hand, or a trusted forwarder's signed ARC record for
  server-side forwarding rules.
- Cleaning of message bodies to plain text, with hidden-text removal (best effort).
- Lane transforms: unzipping password-protected archives with a secret scoped to the
  lane, with the original and extracted files both stored.
- A narrow MCP server for agents: `list_messages`, `get_message`, `create_share_link` and
  `mark_processed`. Agents read only the lanes they were granted, enforced in SQL.
  Text written by third parties comes back under fields named `untrusted*`.
- Short-lived share links for files, on a separate hostname.
- An admin CLI for lanes, agent tokens, secrets, messages and rejections. It prints
  metadata only; bodies need `--show-body`.
- Rate limiting of mail from unlisted senders, a scheduled retention purge, and
  headers-only logging of rejections.
- Deployment from a plain checkout with `npm run deploy`, and a project website.

### Breaking changes

These happened during development, before the first release, so they only affect
anyone running an earlier commit.

- `list_messages` requires a `lane` argument, and nothing lists lanes. An agent can
  only read a lane whose name it was given. A lane the agent cannot read and a lane
  that does not exist get the same refusal.
- `agents mint` is now `agents create`.

### Verification status

Checked with real mail and a real deployment:

- Hand-forwarded mail through iCloud Mail, passing the direct DKIM and SPF check.
- Unzipping a real password-protected archive within the Free plan's CPU limit.
- The MCP read path, share link download and `mark_processed`, from a Claude
  scheduled task, behind the Cloudflare WAF rule described in `docs/security.md`.
- The admin CLI against the real D1 API.

Not yet confirmed:

- Server-side forwarding rules (the ARC path) against a real provider's headers. It is
  covered by tests with synthetic messages only.
- Deploying with Workers Builds. Deploying from a checkout is what has been used.
- Whether Email Routing retries a message when the Worker throws.

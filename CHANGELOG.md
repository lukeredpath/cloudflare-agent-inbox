# Changelog

Releases are 0.x while the project is experimental: any release can contain breaking
changes. Each one is listed here.

## Unreleased

### Added

- An optional HTTP ingest endpoint, `POST /ingest/lanes/<slug>` on its own hostname
  (`docs/ingest.md`), for a trusted program to file a raw message into one lane without
  forwarding it by email. Requests need a Cloudflare Access service token (checked again by
  the Worker, failing closed) and an HMAC-SHA256 signature over the timestamp, method, path
  and body hash, within 300 seconds. Key, timestamp and signature failures all answer the same
  401. A repeat of the same lane, `Message-ID` and body answers 200 with the stored id.
  Messages are parsed, checked and stored exactly as email-path ones, marked `source = 'api'`.
- Per-lane ingest keys, at most two active per lane, managed with `ingest-keys init`,
  `create`, `list` and `revoke`. Secrets are shown once and stored encrypted to a key pair
  whose private half is a Worker secret (`INGEST_PRIVATE_KEY`). Deleting a lane revokes its keys.
- A per-key rate limit (`INGEST_LIMITER`, 60 a minute) that counts only signed requests, and
  an `ingest` log event per request.
- Optional build variables `AGENT_INBOX_INGEST_HOSTNAME` and `AGENT_INBOX_INGEST_ACCESS_AUD`,
  set together with `AGENT_INBOX_ACCESS_TEAM_DOMAIN`.
- Migration `0003_ingest_keys.sql`: `ingest_keys` and `settings` tables, and `source`,
  `ingest_key_id`, `message_id_header` and `body_sha256` columns on `messages`.
- A lane can block senders: `--block-sender <address or *@domain>` (and `--clear-blocked-senders`
  on update), also in the admin interface. It matches the original sender, never the forwarding
  mailbox, and applies only to mail that has already authenticated. Blocked mail is dropped
  silently, logged as the new `sender_blocked` rejection reason, and never stored. This stops a
  mail rule's own confirmation message from triggering the rule. Needs migration `0003_blocked_senders.sql`, applied
  by `npm run deploy`.

## 0.3.0 (2026-11-20)

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
- The project page has a section on the admin interface, with screenshots that follow the page's
  light and dark theme, and a terminal showing the CLI. `npm run screenshots` regenerates the
  pictures from the synthetic seed data.

### Changed

- `npm run build` and `npm run deploy` build the admin app first, and the rendered config now
  includes an `assets` section. The build refuses an admin hostname that repeats the MCP,
  share or mail hostname, and an MCP hostname that repeats the share one. The mail hostname
  may still be the same as the MCP or share hostname.
- The project page puts Get started before the admin and CLI section, and its steps before the
  commands. The experimental note sits above the buttons, the title is larger, and the hero
  diagram shows mail running through a lane to an agent, with the lanes highlighted once on load
  (not with reduced motion). The page stacks below 960px, the terminal has no window dots,
  code blocks have borders, and there is Open Graph metadata.
- The admin message list is easier to scan: the subject is the link, with the sender beneath it, and
  only unprocessed messages are marked (in the website's lemon: solid in light, a faint wash with a
  hairline in dark). The same mark is on the unprocessed counts in the menu and the lane table, a
  processed message is plain text, and a paused lane is a neutral icon in the menu.
- On a phone, admin messages and lanes are cards (title, then one line of detail) instead of a label
  for every field. Each admin screen sets its own tab title, an unknown address no longer marks
  Overview as current, there is a skip link, the page title is larger, status pills are centred on
  title text, and the new-lane name field has an example.
- The admin screenshots are cropped to the page content so they read larger. `npm run
  screenshots` takes a crop for each picture (`docs/admin.md`).

### Fixed

- The project page no longer scrolls sideways on a phone: a wide code block was stretching its
  column.

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

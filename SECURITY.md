# Security policy

## Status

This project is **experimental**. There are no versioned releases: fixes land on
`main`, and only the latest commit is supported.

## Reporting a vulnerability

Please report security issues privately through GitHub's
["Report a vulnerability"](../../security/advisories/new) form on this
repository's Security tab. Do not open a public issue or pull request with
details. If that option is not available to you, open an issue titled "Security
contact request" with **no details** and a private channel will be arranged.

Include what you found, how to reproduce it, and what you think the impact is.
This is a spare-time project: expect an acknowledgement within a few days and a
best-effort fix. There is no bounty programme. Credit is given if you want it.

## In scope

- **Inbound mail authentication:** accepting mail that should be rejected, or
  bypassing the sender allowlist, the DKIM and SPF binding, or the forwarded-mail
  (ARC) checks.
- **Authorization:** an agent reaching a lane it was not granted, a revoked agent
  or a revoked share link still working, or token handling flaws.
- **Disclosure:** anything that leaks message content, secrets, tokens, link URLs
  or deployment details through the Worker, its logs, error messages or the CLI.
- **Resource exhaustion from a single message:** zip bombs, parser blow-ups and
  similar inputs that defeat the documented limits.
- **The repository's own build, CI and deploy scripts**, including anything that
  could leak a credential or personal deployment values.

## Out of scope

- **Prompt injection through message content.** Email bodies are untrusted by
  design and the project does not try to detect malicious instructions in them.
  What a consuming agent does with that text is the operator's responsibility (see
  the threat model). A way to make *untrusted* content appear in a field that is
  presented as trusted **is** in scope.
- **Volumetric floods** of the lane address and platform quota exhaustion. The
  mitigations are documented in [docs/security.md](docs/security.md#cloudflare-protections).
- **Vulnerabilities in Cloudflare, your mail provider, or MCP clients and agents.**
- **Misconfiguration the documentation warns against**, such as listing a shared
  mail provider's domain as an allowed DKIM domain, or using an over-broad API token.
- Reports that need the secret lane address together with access to your
  Cloudflare account or secrets.

## Hardening your deployment

The code is only part of the picture. See
[docs/security.md](docs/security.md#cloudflare-protections) for the Cloudflare rules
worth putting in front of the Worker, and for the known limits of the design.
Practical basics: give the CLI a narrow API token, mint agent tokens yourself in a
terminal, grant each agent only the lanes it needs, rotate a lane's address if it
leaks, and keep consuming agents narrowly scoped.

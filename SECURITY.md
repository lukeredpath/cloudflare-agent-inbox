# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
["Report a vulnerability"](../../security/advisories/new) form on this
repository's Security tab. Do not open a public issue.

Include what you found, how to reproduce it, and what you think the impact is.
You can expect an acknowledgement within a few days.

## Scope

This project accepts mail from an allowlist, stores it, and exposes it to AI
agents through a read-mostly MCP server. Reports about authentication of
inbound mail, lane scoping, token handling, share links, and anything that
could leak message content or deployment details are all in scope.

Safety also depends on what the consuming agent is allowed to do. See the
threat model in the README.

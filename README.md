# cloudflare-agent-inbox

A Cloudflare Worker that files forwarded emails into **lanes**, which AI agents
read through a narrow, mostly read-only MCP server. A separate admin CLI manages
lanes, agent tokens and secrets.

> **Unofficial.** This project is not affiliated with, endorsed by, or
> sponsored by Cloudflare. It runs on Cloudflare's developer platform and uses
> the name descriptively.

**Status:** work in progress. See the milestone list in the repository history
for what exists so far.

## How it works

- Each lane has its own unguessable address and its own policy (allowed
  senders, attachment rules, transforms, retention).
- Inbound mail is accepted only from an allowlist of senders and only when
  Cloudflare's own authentication results show a DKIM pass for an allowed
  domain. Everything else is dropped, with a headers-only log entry.
- Accepted mail is turned into clean plain text deterministically. There is no
  AI in the ingest pipeline.
- Agents get a scoped bearer token and can list, read and mark messages in the
  lanes they were granted, and nothing else.
- There is no admin endpoint on the Worker. Management happens through the CLI,
  which talks to the Cloudflare API with a scoped token.

## Threat model (summary)

Email bodies are untrusted data written by third parties. This project keeps
risk down with tight ingress control, per-lane scoping and a minimal agent
surface, not by filtering content. **Safety therefore also depends on what the
consuming agent is allowed to do**: give an agent that reads email only the
capabilities you would be comfortable with an attacker steering. A fuller
threat model will be added before v1.

## Configuration

Deployment values (hostnames, allowed senders, DKIM domains) are never
committed. `wrangler.example.jsonc` is a template; the real config is rendered
at build time from build variables. See [docs/deploy.md](docs/deploy.md).

Examples in this repository use `example.com` and made-up senders only.

## Development

```sh
npx npm@11 install      # npm 10 can hit a peer-dependency bug with Vitest
npm test                # Vitest inside the Workers runtime
npm run typecheck
git config core.hooksPath .githooks   # enable the pre-commit scans
```

The pre-commit hook scans for personal values using a denylist you keep
outside the repository (`.pii-denylist`, which is git-ignored, or
`~/.config/agent-inbox/denylist.txt`; one term per line). CI runs
[gitleaks](https://github.com/gitleaks/gitleaks) on every push.

## Licence

MIT. See [LICENSE](LICENSE).

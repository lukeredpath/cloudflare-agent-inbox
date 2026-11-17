# CLAUDE.md

Cloudflare Worker that files forwarded emails into lanes, read by agents through
a narrow MCP server, plus an admin CLI. Unofficial; not affiliated with Cloudflare.

## Commands

```sh
npx npm@11 install        # npm 10 hits an arborist bug with vitest's peers
npm test                  # vitest in workerd (@cloudflare/vitest-plugin)
npm run typecheck         # tsc --noEmit
npm run render-config     # needs AGENT_INBOX_* variables; writes dist/wrangler.jsonc
npm run pii-scan          # needs a local denylist (see README)
```

Run `npm test` and `npm run typecheck` before every commit. Node comes from
`mise.toml` (use `mise exec -- ...` if the shim complains).

## Rules that must not be weakened

- **No personal values anywhere in the repo**: no real domains, addresses,
  Cloudflare account/zone/D1/R2 ids, lane names or tokens, in code, tests, docs,
  comments or config. Use `example.com` and made-up senders.
- **No real emails as fixtures**, not even redacted. Fixtures are synthetic.
- **Lanes are data, not code.** Nothing in the repo names a particular merchant,
  employer or agent product, except as generic examples in the README.
- **Never commit the design brief** (`brief*` is git-ignored).
- **No Cloudflare credentials in GitHub.** Deployment is Workers Builds only.
- The real Wrangler config is rendered at build time and never committed.
- Error messages and logs never include deployment values or message bodies.

## Layout

- `src/core/`: shared module imported by both the Worker and the CLI.
- `src/worker/`: Worker entry (`email`, `fetch`, `scheduled`).
- `scripts/`: build-time tooling (`render-config`, `pii-scan`).
- `test/`: Vitest tests (run inside workerd).

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

Local CLI: `npm run cli -- --help` (needs `AGENT_INBOX_CLI_API_TOKEN` or `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`AGENT_INBOX_WORKER_NAME`, `AGENT_INBOX_MAIL_HOSTNAME`, only for commands that use them).

## Releasing

Releases are small and follow the same steps each time:

1. **Review the documentation before anything else.** Read the README, everything under
   `docs/` and the website (`site/index.html`) against what changed since the last
   release. Fix anything stale, overstated or missing. Do this every release, even when
   the change looks internal.
2. Move the CHANGELOG's Unreleased entries under a new `## x.y.z (date)` heading.
   Releases are 0.x: a minor bump for features or behaviour changes, a patch for fixes.
3. Run `npm test` and `npm run typecheck`.
4. Bump the version with `npx npm@11 version x.y.z --no-git-tag-version` (it updates
   `package-lock.json` too) and commit it as `chore(release): x.y.z`.
5. Push `main`, then tag `vx.y.z` and push the tag.
6. Create the GitHub release from the tag with the CHANGELOG entry as its notes. Keep it
   marked as a pre-release while the project is experimental.

Pushing, tagging and publishing are outward-facing: do them only when asked.

## Layout

- `src/core/`: shared by the Worker and the CLI. Pure TypeScript with no Node or Workers APIs
  (WebCrypto only). All relative imports use `.ts` so the CLI runs under Node's type stripping.
  The `Db` interface is the only database surface; the Worker backs it with D1, the CLI with the API.
- `src/worker/`: `email.ts` (ingest pipeline), `ingest.ts` (parse + policy), `transforms.ts` and
  `unzip.ts`, `mcp.ts` (agent tools), `share.ts`, `purge.ts` (cron), `index.ts` (host-based routing).
- `src/cli/`: `commands.ts` (logic), `program.ts` (commander wiring), `cloudflare.ts` and `node.ts`
  (the real API and terminal). Commands take a `CliContext`, so tests run them against local D1.
- `migrations/`: D1 migrations, applied by `npm run deploy`.
- `scripts/`: build-time tooling (`render-config`, `pii-scan`).
- `test/`: Vitest tests (run inside workerd); synthetic fixtures only.

## Design rules worth knowing

- Agent-facing text that comes from email is returned under fields named `untrusted*`.
- Agent reads are scoped to granted lanes inside the SQL itself (`AGENT_SCOPE` in `core/messages.ts`).
- Lane-config schemas have no defaults on the patch side, so an update never resets other fields.
- The CLI never prints bodies without `--show-body`; `test/cli.test.ts` has a sentinel test for it.

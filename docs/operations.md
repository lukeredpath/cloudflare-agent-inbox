# Operations: logs and diagnosing problems

## Where to look

| Source | What it shows | How |
| --- | --- | --- |
| **Workers Logs** | One structured line per email, MCP call, share download and purge. Enabled in the config template, 100% sampled. | Dashboard: your Worker, Observability, Logs |
| **Live tail** | The same lines as they happen, while you reproduce a problem | `npx wrangler tail <worker name>` (needs a token that can read the Worker) |
| **The CLI** | Why mail was rejected, what each message is, transform failures, active share links | `rejections list --diagnostics`, `messages list`, `lanes get <slug>` |
| **Email Routing activity** | Whether Cloudflare received and routed a message to the Worker at all | Dashboard: Email Routing |

## Log events

Every line is JSON with an `event` field. They carry **metadata only**: never
addresses, subjects, bodies, tokens, link URLs or deployment values. Lane and agent
ids are fine: they mean nothing outside the database.

| Event | Fields | When |
| --- | --- | --- |
| `email` | `outcome` (`accepted`, `rejected`, `error`), `lane` (id, or null), `reason` (for rejections), `path` (`direct` or `forwarded`, for accepted), `files`, `bytes`, `ms`, `authenticated` (for errors) | once per inbound message |
| `mcp` | `agent` (id), `tool`, `outcome` (`ok`, `refused`, `internal_error`) | every agent tool call |
| `share` | `outcome` (`served`, `not_found`, `missing_object`), `attachment`, `agent`, `bytes` | every share-link request. Records who used a link and which file, never the link |
| `admin` | `action` (for changes: for example `lanes.update`), `outcome` (`ok`, `refused`, `internal_error`, `access_denied`, `not_configured`, `no_assets`), `status`, `reason` (for `access_denied`) | each change made through the admin interface, and each request it refused. Never who made it or what it touched |
| `purge` | `expired_links`, `expired_messages`, `removed_messages`, `removed_rejections`, `failed_steps` | once per hourly run |
| `purge_step_failed` | `step`, `error` | a purge step failed. The other steps still run, and the run is then failed so Cloudflare shows the cron as errored |

`reason` values are the same as the rejection log, plus `rate_limited` (mail from an
unlisted sender over the rate limit; logged only, never stored): `unknown_address`,
`sender_not_allowed`, `auth_failed`, `lane_paused`, `too_large`,
`attachment_not_allowed`, `parse_error`. An `error` outcome with `authenticated: true`
means a verified forward could not be stored; the sender was told to send it again.

## If the admin interface refuses you

An `admin` line with `outcome: access_denied` says why in `reason`:

| `reason` | Meaning |
| --- | --- |
| `missing` | the request did not come through Cloudflare Access (no token). Check that the Access application covers the whole admin hostname |
| `malformed`, `unknown_key`, `bad_signature` | a token that is not from your Access team: a wrong team domain, or a forged token |
| `bad_claims` | a token for another application, or an expired one. Check that `AGENT_INBOX_ACCESS_AUD` is the audience tag of the application in front of this hostname |
| `keys_unavailable` | the Worker could not fetch Access's signing keys (the response is a 503). Try again |

`not_configured` means one of the three admin variables is missing from the deployed Worker, and
`no_assets` means the admin app was not built into the deploy. See [admin.md](admin.md).

## "My mail did not arrive": a checklist

1. **Did Cloudflare route it?** Look at the Email Routing activity. If it is not
   there, the problem is before the Worker: the sending rule, the address, the MX
   records or the routing rule.
2. **Did the Worker see it?** Look for an `email` line in Workers Logs around that
   time. `outcome: rejected` gives the reason.
3. **Why was it rejected?** `npm run cli -- rejections list --diagnostics`. For
   `auth_failed` the detail says which path failed (`direct:` or `forwarded:`), and the
   diagnostics show the authentication headers Cloudflare saw.
4. **Accepted but missing a file?** `npm run cli -- lanes get <slug>` lists transform
   failures with the reason.
5. **Nothing logged at all?** Subaddressing, the subdomain or the routing rule is
   probably missing; see [getting-started.md](getting-started.md).

## What is not logged (yet)

There is no alerting: nothing notifies you of a spike in errors, or that mail you
expect has stopped arriving. A scheduled check that a lane has received mail within
its expected interval (`lanes list` shows the last receipt) is the simplest
safeguard. Agent reads of messages are not logged individually; only who marked a
message processed, and who created and used share links, are recorded.

# Lane recipes

A lane is a kind of email that needs its own handling. Lanes live in the
database, created with the CLI or the [admin interface](admin.md); nothing in this
repository names any. The examples below use the CLI.

## A text-only lane

```sh
npm run cli -- lanes create receipts --description "Shop receipts"
```

No attachments are accepted by default. A message with any non-image attachment
is dropped and logged as `attachment_not_allowed`.

## A lane for password-protected zipped PDFs

```sh
# 1. The password is a Worker secret, scoped to this lane.
npm run cli -- secrets set LANE_SECRET_STATEMENTS     # value from the prompt or stdin

# 2. The lane unzips with it, accepts only PDFs inside, and allows share links.
npm run cli -- lanes create statements \
  --shareable \
  --unzip-secret LANE_SECRET_STATEMENTS --inner-type application/pdf

# 3. An agent that may read it.
npm run cli -- agents create my-agent        # in your own terminal
npm run cli -- agents grant my-agent statements
```

The original zip and the extracted files are both stored; extracted files are
linked to the zip by `parent_id`. The same zip sent to a lane without the
transform is stored, not unzipped. If extraction fails (wrong password, too many
files, a nested archive, an unexpected inner type) the message is still stored
and the zip is flagged. Check with `lanes get statements`.

## A lane for mail forwarded by a server-side rule

Mail you compose or forward by hand carries your mail provider's DKIM signature
for your domain, so it passes the direct check. A **server-side forwarding rule**
adds no signature, so the lane has to trust the provider's record of the
original sender instead:

```sh
npm run cli -- lanes create statements \
  --forwarded-from billing@billing.example.org          # requires dmarc (default)
```

- The deployment must list the provider in `AGENT_INBOX_TRUSTED_ARC_FORWARDERS`.
- `--forwarded-from address=dkim,spf` accepts the first of several verdicts, and
  is repeatable for several original senders. Prefer the strictest verdict the
  sender actually passes: look at the provider's recorded results before loosening.
- Check what a failed forward looked like with
  `npm run cli -- rejections list --diagnostics`.
- `--forwarded-from '*@shop.example.net'` accepts any address at exactly that
  domain (not its subdomains), and `--forwarded-from '*'` accepts any From
  address. **Quote the `*`**, or the shell expands it. A wildcard vouches for
  senders you did not list, so it may require nothing but `dmarc`: anything
  else is refused, as is a public suffix such as `*@co.uk`. The built-in suffix
  list is a small approximation of the real one, so avoid wildcards on any shared
  suffix.
- With several rules, the most specific one for the From address is used, and only
  that one: an exact address, then `*@domain`, then `*`. A pattern may appear once
  per lane, and a lane holds up to 100 rules.
- The recorded DMARC verdict must be aligned with the actual From domain.
  Senders that mail from a subdomain (for example `mail.shop.example.net`) need
  their own `*@mail.shop.example.net` rule, or `*`.
- `lanes update <slug> --clear-forwarded-from` turns it off.

## Blocking senders

Some mail passes authentication but should never be filed. A typical case: a mail
rule in your provider sends you a confirmation, and its subject repeats the text the
rule matches, so the confirmation triggers the rule and is forwarded to the lane.

```sh
npm run cli -- lanes update statements --block-sender noreply@example.net
npm run cli -- lanes update statements --block-sender '*@alerts.example.net'
```

- A blocked sender is an address or `*@domain` (exactly that domain, not its
  subdomains; **quote the `*`**). Repeat the flag for several, up to 100.
- It matches the **original sender**: the From address of a message forwarded by a
  rule, or the sender of the inner message when you forward one as an attachment. The
  envelope sender, which is your forwarding mailbox, is never checked.
- Blocking happens after authentication, so it cannot be used to find a lane. The
  message is dropped without a bounce and logged as `sender_blocked` in
  `rejections list`. Nothing is stored.
- `--block-sender` replaces the list; `lanes update <slug> --clear-blocked-senders`
  empties it.

## Changing a lane

```sh
npm run cli -- lanes update statements --retention-days 400
npm run cli -- lanes rotate statements        # new address; the old one stops at once
npm run cli -- lanes pause statements         # verified forwards bounce so you notice
```

## Allowed senders

By default a lane uses the deployment's `DEFAULT_ALLOWED_SENDERS`. Set
`--allowed-sender` (repeatable) to give one lane its own list, and
`--clear-allowed-senders` to go back.

## Testing without real mail

```sh
npm run cli -- messages inject-test receipts --subject "Test" --text "Total 3.50 GBP"
```

The message is marked as a test (`is_test` in agent output) so an agent's
handling can be checked without forwarding anything real.

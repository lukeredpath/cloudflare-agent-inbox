# Lane recipes

A lane is a kind of email that needs its own handling. Lanes live in the
database, created with the CLI; nothing in this repository names any.

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
npm run cli -- agents mint my-agent        # in your own terminal
npm run cli -- agents grant my-agent statements
```

The original zip and the extracted files are both stored; extracted files are
linked to the zip by `parent_id`. The same zip sent to a lane without the
transform is stored, not unzipped. If extraction fails (wrong password, too many
files, a nested archive, an unexpected inner type) the message is still stored
and the zip is flagged. Check with `lanes get statements`.

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

import type { CreatedIngestKey, LaneIngestView } from "../../worker/admin/types.ts";
import { attempt, errorText } from "../actions.ts";
import { post } from "../api.ts";
import { refreshAll } from "../data.ts";
import { confirm } from "../dialogs.tsx";
import { formatDay, formatFull, timeAgo } from "../format.ts";
import { Icon } from "../icons.tsx";
import { createStore, useStore } from "../store.ts";
import { copyText, toast } from "../toast.tsx";
import { Panel, Pill } from "../ui.tsx";

interface HeldSecret {
  lane: string;
  id: string;
  secret: string;
  copied: boolean;
}

/**
 * A new key's secret lives only in memory, from creation until it is dismissed: not in a URL, not in
 * storage, and never fetched again (the API cannot return it). A module-level store keeps it while you
 * look at another screen, the same as a new agent's token.
 */
const held = createStore<HeldSecret | null>(null);

/** Shown above the lane once a key is created, until it is hidden. */
export function IngestSecretPanel({ slug, endpoint }: { slug: string; endpoint: string | null }) {
  const value = useStore(held);
  if (!value || value.lane !== slug) return null;

  const dismiss = async () => {
    if (!value.copied) {
      const ok = await confirm({
        title: "Hide the secret without copying it?",
        items: ["Remove the secret from this page for good."],
        note: "If it wasn’t stored, the key is no use. Revoke it and create a new one.",
        confirm: "Hide secret",
      });
      if (!ok) return;
    }
    held.set(null);
    toast("Secret hidden. It can’t be shown again.");
  };

  return (
    <section class="secret-panel" role="region" aria-labelledby="ingest-secret-title">
      <h2 id="ingest-secret-title">
        <Icon name="key" />
        Copy the ingest secret for <span class="mono">{slug}</span> now
      </h2>
      <p>
        It won’t be shown again: only the ingest endpoint can read it back. Give the caller the key id and the secret, for
        example in a password manager and a Docker secret.
      </p>
      <dl class="dl">
        <dt>Key id</dt>
        <dd>
          <code>{value.id}</code>
        </dd>
        {endpoint && (
          <>
            <dt>Endpoint</dt>
            <dd>
              <code>{endpoint}</code>
            </dd>
          </>
        )}
      </dl>
      <div class="token">{value.secret}</div>
      <div class="row">
        <button
          class="btn btn-primary"
          type="button"
          onClick={async () => {
            await copyText(value.secret, "Secret");
            held.set({ ...value, copied: true });
          }}
        >
          <Icon name="copy" />
          Copy secret
        </button>
        <button class="btn" type="button" onClick={() => copyText(value.id, "Key id")}>
          <Icon name="copy" />
          Copy key id
        </button>
        <button class="btn" type="button" onClick={dismiss}>
          {value.copied ? "Done, hide it" : "I have stored it, hide it"}
        </button>
      </div>
    </section>
  );
}

export function IngestKeysPanel({ slug, ingest }: { slug: string; ingest: LaneIngestView }) {
  const active = ingest.keys.filter((k) => !k.revoked_at);
  const full = active.length >= ingest.max_active_keys;

  const create = async () => {
    // A new secret replaces the one on screen, so do not lose one that was never copied.
    const shown = held.get();
    if (shown && !shown.copied) {
      const ok = await confirm({
        title: "Create another key without copying this secret?",
        items: [`Remove the secret for ${shown.id} from this page for good.`, "Create a new key and show its secret instead."],
        note: "If the first secret wasn’t stored, revoke that key.",
        confirm: "Create key",
      });
      if (!ok) return;
    }
    try {
      const created = await post<CreatedIngestKey>(`/api/lanes/${slug}/ingest-keys`);
      held.set({ lane: slug, id: created.key.id, secret: created.secret, copied: false });
      refreshAll();
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast(errorText(e));
    }
  };

  const revoke = async (id: string) => {
    const ok = await confirm({
      title: `Revoke ${id}?`,
      items: ["Refuse requests signed with this key from the next one.", "Keep it in the list, marked revoked."],
      note: "A revoked key can’t be restored. Create a new one instead.",
      confirm: "Revoke key",
    });
    if (!ok) return;
    if (await attempt(() => post(`/api/lanes/${slug}/ingest-keys/${id}/revoke`), `${id} revoked.`)) {
      if (held.get()?.id === id) held.set(null);
    }
  };

  return (
    <Panel
      title="Ingest keys"
      meta={`${active.length} of ${ingest.max_active_keys} active`}
      flush={ingest.keys.length > 0}
      action={
        ingest.ready && (
          <button
            class="btn btn-sm"
            type="button"
            disabled={full}
            title={full ? "Revoke a key first" : undefined}
            onClick={create}
          >
            <Icon name="plus" />
            New key
          </button>
        )
      }
    >
      {ingest.keys.length > 0 && (
        <ul class="att">
          {ingest.keys.map((k) => (
            <li key={k.id}>
              <Icon name="key" />
              <div>
                <code>{k.id}</code>
                <div class="meta">
                  Created {formatDay(k.created_at)},{" "}
                  {k.last_used_at ? <span title={formatFull(k.last_used_at)}>last used {timeAgo(k.last_used_at).toLowerCase()}</span> : "never used"}
                </div>
              </div>
              {k.revoked_at ? (
                <Pill tone="bad">Revoked {formatDay(k.revoked_at)}</Pill>
              ) : (
                <button class="btn btn-sm btn-danger-quiet" type="button" onClick={() => revoke(k.id)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div class={`${ingest.keys.length > 0 ? "panel-body bt " : ""}muted small`}>
        {!ingest.ready ? (
          <>
            Ingest isn’t set up yet. Run <code>npm run cli -- ingest-keys init</code> once, then create keys here.
          </>
        ) : ingest.endpoint ? (
          <>
            Signed requests to <code>{ingest.endpoint}</code> file messages into this lane. A key’s secret is shown once, when
            it is created.
          </>
        ) : (
          <>Keys work once this deployment’s ingest endpoint is configured. A key’s secret is shown once, when it is created.</>
        )}
      </div>
    </Panel>
  );
}

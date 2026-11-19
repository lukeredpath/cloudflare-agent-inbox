import { useState } from "preact/hooks";
import type { AttachmentView, MessageDetail } from "../../worker/admin/types.ts";
import { attempt, errorText } from "../actions.ts";
import { api, del, post, put } from "../api.ts";
import { useResource } from "../data.ts";
import { confirm } from "../dialogs.tsx";
import { formatBytes, formatFull, plural } from "../format.ts";
import { Icon } from "../icons.tsx";
import { navigate, to } from "../router.ts";
import { copyText } from "../toast.tsx";
import { LoadError, MessageFlags, PageHead, PageSkeleton, Panel, ProcessedPill, Untrusted, UntrustedInline } from "../ui.tsx";

type Body = { state: "hidden" } | { state: "loading" } | { state: "shown"; text: string } | { state: "failed"; message: string };

function AttachmentRow({ a, child }: { a: AttachmentView; child?: boolean }) {
  return (
    <li class={child ? "child" : undefined}>
      <Icon name={a.untrusted_content_type === "application/zip" ? "zip" : "file"} />
      <div>
        <UntrustedInline text={a.untrusted_filename} />
        <div class="meta mono">
          {a.untrusted_content_type} · {formatBytes(a.size)}
        </div>
      </div>
      <a class="btn btn-sm" href={`/api/attachments/${a.id}/download`} aria-label={`Download ${a.untrusted_filename}`}>
        <Icon name="download" />
        <span>Download</span>
      </a>
      {a.untrusted_transform_error && (
        <div class="extra">
          <Untrusted text={a.untrusted_transform_error} label="Transform error, may include text from the email" />
        </div>
      )}
    </li>
  );
}

export function MessageScreen({ id }: { id: string }) {
  const { data, error } = useResource<MessageDetail>(`/api/messages/${id}`);
  const [body, setBody] = useState<Body>({ state: "hidden" });

  if (error) return <LoadError error={error} what="This message" />;
  if (!data) return <PageSkeleton />;
  const m = data;

  const showBody = async () => {
    setBody({ state: "loading" });
    try {
      const { untrusted_body } = await api<{ untrusted_body: string }>(`/api/messages/${id}/body`);
      setBody({ state: "shown", text: untrusted_body });
    } catch (e) {
      setBody({ state: "failed", message: errorText(e) });
    }
  };

  const remove = async () => {
    const hasChildren = m.attachments.some((a) => a.parent_id);
    const ok = await confirm({
      title: `Delete message ${m.id}?`,
      items: [
        <>
          Hide the message and its body in <code>{m.lane}</code> at once.
        </>,
        m.attachments.length
          ? `Delete ${plural(m.attachments.length, "attachment")}${hasChildren ? ", including files extracted from archives" : ""}; the files are removed at the next hourly purge.`
          : "It has no attachments.",
        "Stop any agent from reading it, including through share links.",
      ],
      note: "This can’t be undone.",
      confirm: "Delete message",
    });
    if (ok && (await attempt(() => del(`/api/messages/${id}`), `Message ${m.id} deleted.`))) navigate(to.messages());
  };

  const top = m.attachments.filter((a) => !a.parent_id);
  const childrenOf = (parent: string) => m.attachments.filter((a) => a.parent_id === parent);

  return (
    <>
      <PageHead
        crumb={
          <>
            <a href={to.messages()}>Messages</a> /{" "}
            <a href={to.lane(m.lane)} class="mono">
              {m.lane}
            </a>
          </>
        }
        title={
          <>
            Message <span class="mono">{m.id}</span> <ProcessedPill processed={m.processed} />
          </>
        }
        sub={<MessageFlags message={m} />}
        actions={
          <>
            {m.processed && (
              <button
                class="btn"
                type="button"
                // No undo: marking a message unprocessed forgets which agent handled it and what it noted.
                onClick={() => attempt(() => post(`/api/messages/${id}/unprocess`), `${m.id} marked unprocessed. Agents will see it again.`)}
              >
                Mark unprocessed
              </button>
            )}
            <button
              class="btn"
              type="button"
              aria-pressed={m.keep}
              onClick={() =>
                attempt(
                  () => put(`/api/messages/${id}/keep`, { keep: !m.keep }),
                  m.keep ? `${m.id} no longer kept. Retention applies again.` : `${m.id} kept. Retention won’t delete it.`,
                  () => void attempt(() => put(`/api/messages/${id}/keep`, { keep: m.keep })),
                )
              }
            >
              {m.keep ? "Unkeep" : "Keep"}
            </button>
            <button class="btn btn-danger-quiet" type="button" onClick={remove}>
              <Icon name="trash" />
              Delete
            </button>
          </>
        }
      />
      <div class="grid-2">
        <div class="stack">
          <Panel title="Subject">
            <Untrusted text={m.untrusted_subject ?? "(no subject)"} />
          </Panel>

          <Panel title="Body" meta="Hidden until requested">
            {body.state === "shown" ? (
              <>
                <Untrusted text={body.text} label="Message body, from the email, untrusted. Shown as plain text." />
                <div class="row mt-m">
                  <button class="btn btn-sm" type="button" onClick={() => setBody({ state: "hidden" })}>
                    <Icon name="eyeoff" />
                    Hide body
                  </button>
                  <button class="btn btn-sm" type="button" onClick={() => copyText(body.text, "Body text")}>
                    <Icon name="copy" />
                    Copy text
                  </button>
                </div>
              </>
            ) : body.state === "loading" ? (
              <div class="ut" aria-busy="true">
                <div class="ut-label">
                  <Icon name="alert" />
                  Loading body…
                </div>
                <div class="ut-skel">
                  <span class="skel w1" />
                  <span class="skel w2" />
                  <span class="skel w3" />
                </div>
              </div>
            ) : (
              <div class="empty tight">
                <span class="ic">
                  <Icon name="eyeoff" />
                </span>
                <h3>{body.state === "failed" ? "The body couldn’t be loaded" : "Body not loaded"}</h3>
                <p>{body.state === "failed" ? body.message : "The body is fetched only when requested and is shown as plain text inside a marked block."}</p>
                <button class="btn btn-primary" type="button" onClick={showBody}>
                  <Icon name="eye" />
                  {body.state === "failed" ? "Try again" : "Show body"}
                </button>
              </div>
            )}
          </Panel>

          <Panel title="Attachments" meta={String(m.attachments.length)} flush={m.attachments.length > 0}>
            {m.attachments.length ? (
              <ul class="att">
                {top.map((a) => (
                  <>
                    <AttachmentRow key={a.id} a={a} />
                    {childrenOf(a.id).map((c) => (
                      <AttachmentRow key={c.id} a={c} child />
                    ))}
                  </>
                ))}
              </ul>
            ) : (
              <span class="muted">None.</span>
            )}
          </Panel>
        </div>

        <div class="stack">
          <Panel title="Envelope">
            <dl class="dl">
              <dt>Received</dt>
              <dd>{formatFull(m.received_at)}</dd>
              <dt>Lane</dt>
              <dd>
                <a href={to.lane(m.lane)} class="mono">
                  {m.lane}
                </a>
              </dd>
              <dt>Envelope from</dt>
              <dd>
                <UntrustedInline text={m.untrusted_envelope_from} />
              </dd>
              <dt>Header from</dt>
              <dd>{m.untrusted_header_from ? <UntrustedInline text={m.untrusted_header_from} /> : <span class="muted">None</span>}</dd>
              <dt>Size</dt>
              <dd>{formatBytes(m.size)}</dd>
            </dl>
          </Panel>

          <Panel title="Original sender">
            {m.untrusted_original_from ? (
              <Untrusted text={m.untrusted_original_from} label="From header, untrusted" />
            ) : (
              <span class="muted">Not forwarded: this message came directly.</span>
            )}
          </Panel>

          <Panel title="Authentication">
            {m.untrusted_auth_summary ? <UntrustedInline text={m.untrusted_auth_summary} /> : <span class="muted">Not recorded.</span>}
          </Panel>

          <Panel title="Processing">
            {m.processed ? (
              <>
                Processed by{" "}
                <a href={to.agents()} class="mono">
                  {m.processed.by || "an agent"}
                </a>{" "}
                on {formatFull(m.processed.at)}.
                {m.untrusted_processed_note && (
                  <div class="mt-m">
                    <Untrusted text={m.untrusted_processed_note} label="Note written by the agent, untrusted" />
                  </div>
                )}
              </>
            ) : (
              <span class="muted">Not processed by any agent yet.</span>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

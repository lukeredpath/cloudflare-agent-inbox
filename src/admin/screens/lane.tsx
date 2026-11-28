import { useState } from "preact/hooks";
import type { LaneDetail } from "../../worker/admin/types.ts";
import { attempt, errorText, setLaneStatus } from "../actions.ts";
import { api, del, post, put } from "../api.ts";
import { refreshAll, useResource } from "../data.ts";
import { confirm } from "../dialogs.tsx";
import { formatBytes, formatFull, formatWhen, plural, reasonLabel } from "../format.ts";
import { Icon } from "../icons.tsx";
import { navigate, to } from "../router.ts";
import { copyText, toast } from "../toast.tsx";
import { IngestKeysPanel, IngestSecretPanel } from "./lane-ingest.tsx";
import {
  Empty,
  LaneStatusPill,
  LoadError,
  PageHead,
  PageSkeleton,
  Panel,
  Pill,
  ProcessedPill,
  rowLink,
  Untrusted,
  UntrustedInline,
} from "../ui.tsx";

function AddressPanel({ slug, masked, fresh }: { slug: string; masked: string; fresh: string | null }) {
  const [address, setAddress] = useState<string | null>(fresh);
  const [shown, setShown] = useState(fresh !== null);

  const fetchAddress = async (): Promise<string | null> => {
    if (address) return address;
    try {
      const { address: full } = await api<{ address: string }>(`/api/lanes/${slug}/address`);
      setAddress(full);
      return full;
    } catch (e) {
      toast(errorText(e));
      return null;
    }
  };

  return (
    <Panel title="Address" meta="Semi-secret: anyone with it can send to this lane">
      <div class="row">
        <code class="masked" aria-label={shown ? "Lane address" : "Lane address, hidden"}>
          {shown && address ? address : masked}
        </code>
        <button
          class="btn"
          type="button"
          aria-pressed={shown}
          onClick={async () => {
            if (shown) return setShown(false);
            if (await fetchAddress()) setShown(true);
          }}
        >
          <Icon name={shown ? "eyeoff" : "eye"} />
          {shown ? "Hide" : "Reveal"}
        </button>
        <button
          class="btn"
          type="button"
          onClick={async () => {
            const full = await fetchAddress();
            if (full) await copyText(full, "Address");
          }}
        >
          <Icon name="copy" />
          Copy
        </button>
      </div>
    </Panel>
  );
}

export function LaneScreen({ slug }: { slug: string }) {
  const { data, error } = useResource<LaneDetail>(`/api/lanes/${slug}`);
  const [rotated, setRotated] = useState<string | null>(null);
  const [grant, setGrant] = useState("");

  if (error) return <LoadError error={error} what="This lane" />;
  if (!data) return <PageSkeleton />;
  const { lane } = data;
  const unzip = lane.attachment_policy.transforms.find((t) => t.type === "unzip");
  const grantChoice = data.grantable_agents.includes(grant) ? grant : (data.grantable_agents[0] ?? "");

  const rotate = async () => {
    const ok = await confirm({
      title: `Rotate the address for ${lane.slug}?`,
      items: [
        "Generate a new address for this lane.",
        "Reject mail sent to the current address from now on, logged as a probe.",
        "Leave stored messages, grants and share links as they are.",
      ],
      note: "Forwarding set up at the sender’s side must be changed to the new address. This can’t be undone.",
      confirm: "Rotate address",
    });
    if (!ok) return;
    try {
      const { address } = await post<{ address: string }>(`/api/lanes/${slug}/rotate`);
      setRotated(address);
      refreshAll();
      toast("Address rotated. The new address is shown.");
    } catch (e) {
      toast(errorText(e));
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete lane ${lane.slug}?`,
      items: [
        `Hide ${plural(data.message_count, "stored message")} and their attachments at once; the files are removed at the next hourly purge.`,
        data.agents.length ? `Remove the grant from ${data.agents.join(" and ")}.` : "It has no agent grants.",
        data.shares.length ? `Stop ${plural(data.shares.length, "active share link")} working.` : "It has no active share links.",
        "Reject future mail to its address as an unknown recipient.",
      ],
      note: "This can’t be undone. The rejection log is kept.",
      confirm: "Delete lane",
      typeToConfirm: lane.slug,
    });
    if (!ok) return;
    if (await attempt(() => del(`/api/lanes/${slug}`), `Lane ${lane.slug} deleted.`)) navigate(to.overview());
  };

  return (
    <>
      <PageHead
        crumb={<a href={to.overview()}>Overview</a>}
        title={
          <>
            <span class="mono">{lane.slug}</span> <LaneStatusPill status={lane.status} />
          </>
        }
        sub={lane.description || undefined}
        actions={
          <>
            <a class="btn" href={to.editLane(slug)}>
              <Icon name="edit" />
              Edit
            </a>
            <button class="btn" type="button" onClick={() => setLaneStatus(slug, lane.status === "active" ? "paused" : "active")}>
              <Icon name={lane.status === "active" ? "pause" : "play"} />
              {lane.status === "active" ? "Pause" : "Resume"}
            </button>
            <button class="btn" type="button" onClick={rotate}>
              <Icon name="rotate" />
              Rotate address
            </button>
            <button class="btn btn-danger-quiet" type="button" onClick={remove}>
              <Icon name="trash" />
              Delete
            </button>
          </>
        }
      />
      <IngestSecretPanel slug={lane.slug} endpoint={data.ingest.endpoint} />
      <div class="grid-2">
        <div class="stack">
          <AddressPanel key={rotated ?? "masked"} slug={slug} masked={lane.address_masked} fresh={rotated} />

          <Panel
            title="Recent messages"
            flush
            action={
              <a class="btn btn-sm btn-ghost" href={to.messages({ lane: slug })}>
                All {data.message_count}
              </a>
            }
          >
            {data.recent_messages.length ? (
              <div class="table-wrap">
                <table class="table cards">
                  <thead>
                    <tr>
                      <th>Received</th>
                      <th>Subject</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_messages.map((m) => (
                      <tr key={m.id} class="clickable" onClick={rowLink(to.message(m.id))}>
                        <td class="nowrap">{formatWhen(m.received_at)}</td>
                        <td class="t1 full">
                          <a class="cell-link" href={to.message(m.id)}>
                            <UntrustedInline text={m.untrusted_subject ?? "(no subject)"} truncate />
                          </a>
                        </td>
                        <td class="end">
                          <ProcessedPill processed={m.processed} quiet />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="mail" title="No messages yet" text="Mail forwarded to this lane’s address appears here." />
            )}
          </Panel>

          <Panel title="Transform failures" meta={String(data.transform_failures.length)} flush={data.transform_failures.length > 0}>
            {data.transform_failures.length ? (
              <ul class="att">
                {data.transform_failures.map((f) => (
                  <li key={f.attachment_id}>
                    <Icon name="zip" />
                    <div>
                      <a href={to.message(f.message_id)}>{f.message_id}</a> <span class="muted">{formatWhen(f.received_at)}</span>{" "}
                      <UntrustedInline text={f.untrusted_filename} />
                      <div class="extra mt-s">
                        <Untrusted text={f.untrusted_error} label="Transform error, may include text from the email" />
                      </div>
                    </div>
                    <span />
                  </li>
                ))}
              </ul>
            ) : (
              <span class="muted">None.</span>
            )}
          </Panel>

          <Panel
            title="Recent rejections"
            flush={data.rejections.length > 0}
            action={
              <a class="btn btn-sm btn-ghost" href={to.rejections()}>
                Log
              </a>
            }
          >
            {data.rejections.length ? (
              <div class="table-wrap">
                <table class="table stack-sm">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Reason</th>
                      <th>Sender</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rejections.map((r) => (
                      <tr key={r.id}>
                        <td data-l="When" class="nowrap">
                          {formatWhen(r.received_at)}
                        </td>
                        <td data-l="Reason">{reasonLabel(r.reason)}</td>
                        <td data-l="Sender">
                          <UntrustedInline text={r.untrusted_envelope_from} truncate />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <span class="muted">None in the retained log.</span>
            )}
          </Panel>
        </div>

        <div class="stack">
          <Panel title="Agents" meta={`${data.agents.length} granted`} flush>
            {data.agents.length ? (
              <ul class="att">
                {data.agents.map((name) => (
                  <li key={name}>
                    <Icon name="agent" />
                    <a href={to.agents()} class="mono">
                      {name}
                    </a>
                    <button
                      class="btn btn-sm"
                      type="button"
                      onClick={() =>
                        attempt(
                          () => del(`/api/lanes/${slug}/grants/${name}`),
                          `${name} can no longer read ${slug}.`,
                          () => void attempt(() => put(`/api/lanes/${slug}/grants/${name}`), `${name} can read ${slug} again.`),
                        )
                      }
                    >
                      Ungrant
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div class="panel-body muted">No agent can read this lane.</div>
            )}
            {data.grantable_agents.length > 0 && (
              <div class="panel-body row bt">
                <label class="sr" for="grant-sel">
                  Agent to grant
                </label>
                <select class="select grow" id="grant-sel" value={grantChoice} onChange={(e) => setGrant(e.currentTarget.value)}>
                  {data.grantable_agents.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <button
                  class="btn"
                  type="button"
                  onClick={() => attempt(() => put(`/api/lanes/${slug}/grants/${grantChoice}`), `${grantChoice} can now read ${slug}.`)}
                >
                  <Icon name="plus" />
                  Grant
                </button>
              </div>
            )}
          </Panel>

          <IngestKeysPanel slug={lane.slug} ingest={data.ingest} />

          <Panel title="Active share links" meta="Links are never shown here" flush={data.shares.length > 0}>
            {data.shares.length ? (
              <div class="table-wrap">
                <table class="table stack-sm">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>File</th>
                      <th>Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.shares.map((s) => (
                      <tr key={`${s.created_at}${s.untrusted_filename}`}>
                        <td data-l="Agent" class="mono">
                          {s.agent ?? "unknown"}
                        </td>
                        <td data-l="File">
                          <UntrustedInline text={s.untrusted_filename} truncate />
                        </td>
                        <td data-l="Expires" class="nowrap" title={formatFull(s.expires_at)}>
                          {formatWhen(s.expires_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <span class="muted">{lane.shareable ? "None." : "Sharing is off for this lane."}</span>
            )}
          </Panel>

          <Panel title="Configuration">
            <dl class="dl">
              <dt>Allowed senders</dt>
              <dd>
                {lane.allowed_senders ? lane.allowed_senders.map((s, i) => (
                  <span key={s}>
                    {i > 0 && ", "}
                    <code>{s}</code>
                  </span>
                )) : "Deployment default"}
              </dd>
              <dt>Forwarded-from rules</dt>
              <dd>
                {lane.forwarded_from.length === 0 ? (
                  "None: only direct, DKIM-authenticated mail"
                ) : (
                  <>
                    {plural(lane.forwarded_from.length, "rule")}
                    <div class="muted small">
                      {lane.forwarded_from.slice(0, 3).map((r) => (
                        <div key={r.from}>
                          <code>{r.from}</code> {r.require.join(" or ")}
                        </div>
                      ))}
                      {lane.forwarded_from.length > 3 && <div>and {lane.forwarded_from.length - 3} more</div>}
                    </div>
                  </>
                )}
              </dd>
              <dt>Blocked senders</dt>
              <dd>
                {lane.blocked_senders.length === 0
                  ? "None"
                  : lane.blocked_senders.map((s, i) => (
                      <span key={s}>
                        {i > 0 && ", "}
                        <code>{s}</code>
                      </span>
                    ))}
              </dd>
              <dt>Shareable</dt>
              <dd>{lane.shareable ? "Yes" : "No"}</dd>
              <dt>Attachment types</dt>
              <dd>
                {lane.attachment_policy.allowed_types.length
                  ? lane.attachment_policy.allowed_types.map((t, i) => (
                      <span key={t}>
                        {i > 0 && ", "}
                        <code>{t}</code>
                      </span>
                    ))
                  : "None allowed"}
              </dd>
              <dt>Max attachment</dt>
              <dd>{formatBytes(lane.attachment_policy.max_attachment_bytes)}</dd>
              <dt>Unzip</dt>
              <dd>
                {unzip ? (
                  <>
                    On, secret <code>{unzip.password_secret}</code>, inner {unzip.allow_inner_types.map((t) => <code key={t}>{t} </code>)}
                  </>
                ) : (
                  "Off"
                )}
              </dd>
              <dt>Limits</dt>
              <dd>
                {formatBytes(lane.max_bytes)} per message, {lane.max_text_chars.toLocaleString("en-GB")} text characters, kept{" "}
                {lane.retention_days} days
              </dd>
            </dl>
            {lane.status === "paused" && (
              <p class="mt-m">
                <Pill tone="warn">Paused</Pill>
              </p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

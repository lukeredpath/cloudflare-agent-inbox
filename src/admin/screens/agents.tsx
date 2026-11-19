import { useContext, useEffect, useState } from "preact/hooks";
import type { AgentView } from "../../worker/admin/types.ts";
import { attempt } from "../actions.ts";
import { ApiRequestError, post } from "../api.ts";
import { refreshAll, useResource } from "../data.ts";
import { confirm, Modal } from "../dialogs.tsx";
import { formatDay } from "../format.ts";
import { Icon } from "../icons.tsx";
import { OverviewContext } from "../overview-context.ts";
import { to } from "../router.ts";
import { createStore, useStore } from "../store.ts";
import { copyText, toast } from "../toast.tsx";
import { Empty, Field, LoadError, PageHead, PageSkeleton, Pill } from "../ui.tsx";
import { newAgentRequested } from "./new-agent.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/**
 * The token lives only in memory, from creation until it is dismissed: not in a URL, not in storage.
 * A module-level store (rather than screen state) keeps it while you look at another screen.
 */
const secret = createStore<{ agent: string; token: string; copied: boolean } | null>(null);

function SecretPanel({ value }: { value: { agent: string; token: string; copied: boolean } }) {
  const dismiss = async () => {
    if (!value.copied) {
      const ok = await confirm({
        title: "Hide the token without copying it?",
        items: ["Remove the token from this page for good."],
        note: "If it wasn’t stored, the agent can’t connect. Revoke it and create a new one.",
        confirm: "Hide token",
      });
      if (!ok) return;
    }
    secret.set(null);
    toast("Token hidden. It can’t be shown again.");
  };
  return (
    <section class="secret-panel" role="region" aria-labelledby="token-title">
      <h2 id="token-title">
        <Icon name="key" />
        Copy the token for <span class="mono">{value.agent}</span> now
      </h2>
      <p>It won’t be shown again. Only a hash is stored; if it is lost, revoke the agent and create a new one.</p>
      <div class="token">{value.token}</div>
      <div class="row">
        <button
          class="btn btn-primary"
          type="button"
          onClick={async () => {
            await copyText(value.token, "Token");
            secret.set({ ...value, copied: true });
          }}
        >
          <Icon name="copy" />
          Copy token
        </button>
        <button class="btn" type="button" onClick={dismiss}>
          {value.copied ? "Done, hide it" : "I have stored it, hide it"}
        </button>
      </div>
    </section>
  );
}

function NewAgentDialog({ onClose }: { onClose: () => void }) {
  const lanes = useContext(OverviewContext).data?.lanes ?? [];
  const [name, setName] = useState("");
  const [granted, setGranted] = useState<string[]>([]);
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!NAME.test(name)) {
      setProblem(name ? "Use letters, digits, dot, dash and underscore, up to 40, starting with a letter or digit." : "Enter a name.");
      return;
    }
    setSaving(true);
    try {
      const created = await post<{ agent: AgentView; token: string }>("/api/agents", { name, lanes: granted });
      secret.set({ agent: created.agent.name, token: created.token, copied: false });
      refreshAll();
      onClose();
    } catch (err) {
      setProblem(err instanceof ApiRequestError ? (err.issues[0]?.message ?? err.message) : "Something went wrong.");
      setSaving(false);
    }
  };

  return (
    <Modal labelledBy="new-agent-title" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <div class="dlg-head">
          <h2 id="new-agent-title">New agent</h2>
          <p class="muted">A token is generated and shown once.</p>
        </div>
        <div class="dlg-body">
          <Field id="agent-name" label="Name" error={problem}>
            <input
              class="input mono"
              id="i-agent-name"
              value={name}
              autocomplete="off"
              spellcheck={false}
              aria-describedby="e-agent-name"
              aria-invalid={problem ? true : undefined}
              onInput={(e) => {
                setName(e.currentTarget.value);
                setProblem("");
              }}
            />
          </Field>
          <div class="field" role="group" aria-labelledby="grant-label">
            <span class="label" id="grant-label">
              Lanes to grant
            </span>
            <div class="checks">
              {lanes.map((l) => (
                <label class="check" key={l.slug}>
                  <input
                    type="checkbox"
                    checked={granted.includes(l.slug)}
                    onChange={() => setGranted(granted.includes(l.slug) ? granted.filter((s) => s !== l.slug) : [...granted, l.slug])}
                  />
                  <code>{l.slug}</code>
                </label>
              ))}
            </div>
            <p class="hint">Grants can be changed later from each lane.</p>
          </div>
        </div>
        <div class="dlg-foot">
          <button class="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button class="btn btn-primary" type="submit" disabled={saving}>
            Create agent
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AgentsScreen() {
  const { data, error } = useResource<AgentView[]>("/api/agents");
  const held = useStore(secret);
  const requested = useStore(newAgentRequested);
  const [creating, setCreating] = useState(false);

  // Asked for from the palette or the `n` shortcut on another screen.
  useEffect(() => {
    if (requested) {
      setCreating(true);
      newAgentRequested.set(false);
    }
  }, [requested]);

  const revoke = async (agent: AgentView) => {
    const ok = await confirm({
      title: `Revoke ${agent.name}?`,
      items: [
        "Stop its token working from the next request.",
        "Stop any share links it created working.",
        "Keep it in the list, marked revoked.",
      ],
      note: "A revoked agent can’t be restored. Create a new agent instead.",
      confirm: "Revoke agent",
    });
    if (ok) await attempt(() => post(`/api/agents/${agent.name}/revoke`), `${agent.name} revoked.`);
  };

  return (
    <>
      <PageHead
        title="Agents"
        sub="Each agent has one bearer token and reads only the lanes it is granted."
        actions={
          <button class="btn btn-primary" type="button" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            New agent
          </button>
        }
      />
      {held && <SecretPanel value={held} />}
      {error ? (
        <LoadError error={error} what="Agents" />
      ) : !data ? (
        <PageSkeleton />
      ) : data.length === 0 ? (
        <section class="panel">
          <Empty icon="agent" title="No agents yet" text="An agent is what reads a lane over MCP. Create one, then paste its token into the agent’s connector." />
        </section>
      ) : (
        <section class="panel">
          <div class="table-wrap">
            <table class="table stack-sm">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Granted lanes</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th>
                    <span class="sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.name}>
                    <td data-l="Agent" class="mono">
                      {a.name}
                    </td>
                    <td data-l="Lanes">
                      {!a.revoked_at && a.lanes.length ? (
                        a.lanes.map((l, i) => (
                          <span key={l}>
                            {i > 0 && ", "}
                            <a href={to.lane(l)} class="mono">
                              {l}
                            </a>
                          </span>
                        ))
                      ) : (
                        <span class="muted">None</span>
                      )}
                    </td>
                    <td data-l="Created" class="nowrap">
                      {formatDay(a.created_at)}
                    </td>
                    <td data-l="Status">{a.revoked_at ? <Pill tone="bad">Revoked {formatDay(a.revoked_at)}</Pill> : <Pill tone="ok">Active</Pill>}</td>
                    <td class="num no-label">
                      {!a.revoked_at && (
                        <button class="btn btn-sm btn-danger-quiet" type="button" onClick={() => revoke(a)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {creating && <NewAgentDialog onClose={() => setCreating(false)} />}
    </>
  );
}

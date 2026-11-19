import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { LaneDetail, LaneView } from "../../worker/admin/types.ts";
import { errorText } from "../actions.ts";
import { ApiRequestError, patch, post } from "../api.ts";
import { refreshAll, useResource } from "../data.ts";
import { Modal } from "../dialogs.tsx";
import { Icon } from "../icons.tsx";
import {
  COMMON_TYPES,
  emptyForm,
  FIELD_LABELS,
  formFromLane,
  mapIssues,
  MAX_RULES,
  parseBulk,
  ruleError,
  toRequest,
  validate,
  VERDICTS,
  type FieldKey,
  type LaneForm,
  type MappedIssues,
  type RuleRow,
} from "../lane-form-model.ts";
import { navigate, to } from "../router.ts";
import { toast } from "../toast.tsx";
import { describedBy, Field, FieldGroup, LoadError, PageHead, PageSkeleton } from "../ui.tsx";

export function LaneFormScreen({ slug }: { slug: string | null }) {
  const { data, error } = useResource<LaneDetail>(slug ? `/api/lanes/${slug}` : null);
  if (slug === null) return <LaneFormBody isNew initial={emptyForm()} />;
  if (error) return <LoadError error={error} what="This lane" />;
  if (!data) return <PageSkeleton />;
  return <LaneFormBody key={data.lane.slug} isNew={false} initial={formFromLane(data.lane)} lane={data.lane} />;
}

const none: MappedIssues = { fields: {}, rules: {}, other: [] };

function LaneFormBody({ isNew, initial, lane }: { isNew: boolean; initial: LaneForm; lane?: LaneView }) {
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<MappedIssues>(none);
  const [summary, setSummary] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [pasting, setPasting] = useState(false);

  const clientErrors = validate(form, isNew);
  const errorFor = (key: FieldKey): string | undefined => {
    const shown = tried || touched[key];
    return (shown ? clientErrors[key] : undefined) ?? server.fields[key];
  };
  const touch = (key: FieldKey) => () => setTouched((t) => ({ ...t, [key]: true }));
  // Editing anything clears what the server said, since it is no longer about this input.
  const update = (patchState: Partial<LaneForm>) => {
    setForm((f) => ({ ...f, ...patchState }));
    setServer(none);
  };

  const toggle = (key: "types" | "inner", type: string) => {
    const has = form[key].includes(type);
    update({ [key]: has ? form[key].filter((t) => t !== type) : [...form[key], type] });
  };

  const focusField = (key: FieldKey) => {
    const el = document.getElementById(`i-${key}`) ?? document.querySelector<HTMLElement>(`[data-field="${key}"] input, [data-field="${key}"] textarea`);
    el?.focus();
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setTried(true);
    const keys = (Object.keys(clientErrors) as FieldKey[]).filter((k) => clientErrors[k]);
    if (keys.length) {
      setSummary(keys.map((k) => `${FIELD_LABELS[k]}: ${clientErrors[k]}`));
      requestAnimationFrame(() => document.getElementById("err-summary")?.focus());
      return;
    }
    setSaving(true);
    try {
      const body = toRequest(form, isNew);
      if (isNew) await post("/api/lanes", body);
      else await patch(`/api/lanes/${lane!.slug}`, body);
      refreshAll();
      toast(isNew ? `Lane ${form.slug} created.` : "Changes saved.");
      navigate(to.lane(form.slug));
    } catch (err) {
      const lines: string[] = [];
      if (err instanceof ApiRequestError && err.issues.length) {
        const mapped = mapIssues(err.issues);
        setServer(mapped);
        lines.push(...Object.entries(mapped.fields).map(([k, m]) => `${FIELD_LABELS[k as FieldKey]}: ${m}`), ...mapped.other);
      } else if (err instanceof ApiRequestError && err.status === 409) {
        setServer({ ...none, fields: { slug: err.message } });
        lines.push(`${FIELD_LABELS.slug}: ${err.message}`);
      } else lines.push(errorText(err));
      setSummary(lines);
      requestAnimationFrame(() => document.getElementById("err-summary")?.focus());
    } finally {
      setSaving(false);
    }
  };

  const typeChecks = (key: "types" | "inner", invalid?: boolean) => (
    <div class="checks" id={`i-${key}`}>
      {COMMON_TYPES.map((t) => (
        <label class="check" key={t}>
          <input type="checkbox" checked={form[key].includes(t)} onChange={() => toggle(key, t)} onBlur={touch(key)} aria-invalid={invalid || undefined} />
          <code>{t}</code>
        </label>
      ))}
    </div>
  );

  return (
    <>
      <PageHead
        title={lane ? <>Edit <span class="mono">{lane.slug}</span></> : "New lane"}
        sub={lane ? "Changes apply to mail received after saving." : "A new address is generated when the lane is created."}
        crumb={
          lane ? (
            <>
              <a href={to.overview()}>Overview</a> / <a href={to.lane(lane.slug)}>{lane.slug}</a> / Edit
            </>
          ) : (
            <>
              <a href={to.overview()}>Overview</a> / New lane
            </>
          )
        }
      />
      <form class="form form-narrow" noValidate onSubmit={submit}>
        {summary && (
          <div class="err-summary" id="err-summary" role="alert" tabIndex={-1}>
            <strong>{summary.length === 1 ? "1 thing needs attention" : `${summary.length} things need attention`}</strong>
            <ul>
              {summary.map((line) => {
                const key = (Object.keys(FIELD_LABELS) as FieldKey[]).find((k) => line.startsWith(`${FIELD_LABELS[k]}:`));
                return (
                  <li key={line}>
                    {key ? (
                      <button type="button" class="link" onClick={() => focusField(key)}>
                        {line}
                      </button>
                    ) : (
                      line
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <section class="panel">
          <div class="panel-head">
            <h2>Basics</h2>
          </div>
          <div class="panel-body form">
            {isNew && (
              <Field id="slug" label="Lane name" hint="Lowercase letters, digits and hyphens. Agents see this name; it cannot be changed later." error={errorFor("slug")}>
                <input
                  class="input mono"
                  id="i-slug"
                  value={form.slug}
                  autocomplete="off"
                  spellcheck={false}
                  aria-describedby={describedBy("slug", true)}
                  aria-invalid={errorFor("slug") ? true : undefined}
                  onInput={(e) => update({ slug: e.currentTarget.value })}
                  onBlur={touch("slug")}
                />
              </Field>
            )}
            <Field id="description" label="Description" hint="Shown to you here; helps you remember what belongs in the lane." error={errorFor("description")}>
              <input
                class="input"
                id="i-description"
                value={form.description}
                aria-describedby={describedBy("description", true)}
                aria-invalid={errorFor("description") ? true : undefined}
                onInput={(e) => update({ description: e.currentTarget.value })}
                onBlur={touch("description")}
              />
            </Field>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2>Who can send</h2>
          </div>
          <div class="panel-body form">
            <FieldGroup
              id="senders"
              label="Allowed senders"
              hint="Addresses whose own signed mail is accepted directly, checked against the envelope sender."
              error={errorFor("senders")}
            >
              <div class="checks" role="radiogroup" aria-labelledby="l-senders">
                <label class="check">
                  <input type="radio" name="senders-mode" checked={form.sendersMode === "default"} onChange={() => update({ sendersMode: "default" })} /> Use deployment default
                </label>
                <label class="check">
                  <input type="radio" name="senders-mode" checked={form.sendersMode === "list"} onChange={() => update({ sendersMode: "list" })} /> Use this list
                </label>
              </div>
              {form.sendersMode === "list" && (
                <textarea
                  class="textarea"
                  id="i-senders"
                  rows={3}
                  placeholder="one address per line"
                  spellcheck={false}
                  value={form.senders}
                  aria-describedby={describedBy("senders", true)}
                  aria-invalid={errorFor("senders") ? true : undefined}
                  onInput={(e) => update({ senders: e.currentTarget.value })}
                  onBlur={touch("senders")}
                />
              )}
            </FieldGroup>

            <FieldGroup
              id="rules"
              label="Forwarded-from rules"
              hint={
                <>
                  For mail forwarded by a trusted forwarder: matched against the original sender, each rule listing the verdicts that may vouch for it. Wildcards (
                  <code>*@domain</code> or <code>*</code>) may only require dmarc. With no rules, only direct mail is accepted.
                </>
              }
              error={errorFor("rules")}
            >
              <RulesEditor
                rules={form.rules}
                invalid={Boolean(errorFor("rules"))}
                showErrors={tried}
                serverErrors={server.rules}
                onChange={(rules) => update({ rules })}
                onPaste={() => setPasting(true)}
              />
            </FieldGroup>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2>Attachments</h2>
          </div>
          <div class="panel-body form">
            <FieldGroup id="types" label="Allowed attachment types" hint="With none, any message with an attachment is rejected." error={errorFor("types")}>
              {typeChecks("types", Boolean(errorFor("types")))}
              <label class="sr" for="i-other-types">
                Other types, one per line
              </label>
              <textarea
                class="textarea"
                id="i-other-types"
                rows={2}
                placeholder="other types, one per line, for example image/webp"
                spellcheck={false}
                value={form.otherTypes}
                onInput={(e) => update({ otherTypes: e.currentTarget.value })}
                onBlur={touch("types")}
              />
            </FieldGroup>
            <Field id="maxAtt" label="Max attachment size" error={errorFor("maxAtt")}>
              <NumberInput id="maxAtt" unit="MB" value={form.maxAtt} invalid={Boolean(errorFor("maxAtt"))} onChange={(v) => update({ maxAtt: v })} onBlur={touch("maxAtt")} />
            </Field>
            <label class="check">
              <input type="checkbox" checked={form.shareable} onChange={(e) => update({ shareable: e.currentTarget.checked })} /> Shareable: agents may create expiring links to attachments
            </label>
            <label class="check">
              <input type="checkbox" checked={form.unzipOn} onChange={(e) => update({ unzipOn: e.currentTarget.checked })} /> Unzip archives
            </label>
            {form.unzipOn && (
              <div class="form indent">
                <Field
                  id="secret"
                  label="Secret name"
                  hint="Name of a Worker secret holding the archive password, set with the CLI. The value is never shown here. Zip files are allowed automatically while this is on."
                  error={errorFor("secret")}
                >
                  <input
                    class="input mono"
                    id="i-secret"
                    value={form.secret}
                    spellcheck={false}
                    autocomplete="off"
                    aria-describedby={describedBy("secret", true)}
                    aria-invalid={errorFor("secret") ? true : undefined}
                    onInput={(e) => update({ secret: e.currentTarget.value })}
                    onBlur={touch("secret")}
                  />
                </Field>
                <FieldGroup id="inner" label="Allowed inner types" error={errorFor("inner")}>
                  {typeChecks("inner", Boolean(errorFor("inner")))}
                  <label class="sr" for="i-inner-other">
                    Other inner types, one per line
                  </label>
                  <textarea
                    class="textarea"
                    id="i-inner-other"
                    rows={2}
                    placeholder="other types, one per line"
                    spellcheck={false}
                    value={form.innerOther}
                    onInput={(e) => update({ innerOther: e.currentTarget.value })}
                    onBlur={touch("inner")}
                  />
                </FieldGroup>
              </div>
            )}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2>Limits</h2>
          </div>
          <div class="panel-body field-row">
            <Field id="bytes" label="Message size" error={errorFor("bytes")}>
              <NumberInput id="bytes" unit="MB" value={form.bytes} invalid={Boolean(errorFor("bytes"))} onChange={(v) => update({ bytes: v })} onBlur={touch("bytes")} />
            </Field>
            <Field id="chars" label="Text characters" error={errorFor("chars")}>
              <NumberInput id="chars" unit="chars" value={form.chars} invalid={Boolean(errorFor("chars"))} onChange={(v) => update({ chars: v })} onBlur={touch("chars")} />
            </Field>
            <Field id="days" label="Retention" error={errorFor("days")}>
              <NumberInput id="days" unit="days" value={form.days} invalid={Boolean(errorFor("days"))} onChange={(v) => update({ days: v })} onBlur={touch("days")} />
            </Field>
          </div>
        </section>

        <div class="form-foot">
          <a class="btn" href={lane ? to.lane(lane.slug) : to.overview()}>
            Cancel
          </a>
          <button class="btn btn-primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : lane ? "Save changes" : "Create lane"}
          </button>
        </div>
      </form>

      {pasting && (
        <PasteRules
          room={MAX_RULES - form.rules.length}
          existing={form.rules}
          onClose={() => setPasting(false)}
          onAdd={(rules) => {
            update({ rules: [...form.rules, ...rules.map((r) => ({ ...r, touched: false }))] });
            toast(`${rules.length === 1 ? "1 rule" : `${rules.length} rules`} added.`);
          }}
        />
      )}
    </>
  );
}

function NumberInput({
  id,
  unit,
  value,
  invalid,
  onChange,
  onBlur,
}: {
  id: FieldKey;
  unit: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <div class="row tight">
      <input
        class="input narrow"
        type="number"
        inputMode="decimal"
        step="any"
        id={`i-${id}`}
        value={value}
        aria-describedby={describedBy(id, false)}
        aria-invalid={invalid || undefined}
        onInput={(e) => onChange(e.currentTarget.value)}
        onBlur={onBlur}
      />
      <span class="muted">{unit}</span>
    </div>
  );
}

/* ---------- Forwarded-from rules ---------- */

function RulesEditor({
  rules,
  invalid,
  showErrors,
  serverErrors,
  onChange,
  onPaste,
}: {
  rules: RuleRow[];
  invalid: boolean;
  showErrors: boolean;
  serverErrors: Record<number, string>;
  onChange: (rules: RuleRow[]) => void;
  onPaste: () => void;
}) {
  const setRule = (i: number, next: Partial<RuleRow>) => onChange(rules.map((r, n) => (n === i ? { ...r, ...next } : r)));
  const full = rules.length >= MAX_RULES;

  return (
    <div class={`le${invalid ? " invalid" : ""}`}>
      <div class="le-head">
        <span>Original sender</span>
        <span>Required verdicts</span>
        <span />
      </div>
      {rules.length === 0 && <div class="le-empty">No rules yet. Add one, or paste a list.</div>}
      {rules.map((rule, i) => {
        const wildcard = rule.from.trim().startsWith("*");
        const message = (showErrors || rule.touched ? ruleError(rule, i, rules) : "") || serverErrors[i] || "";
        return (
          <div class="le-row" key={i}>
            <label class="sr" for={`rule-${i}`}>
              Rule {i + 1} pattern
            </label>
            <input
              class="input"
              id={`rule-${i}`}
              value={rule.from}
              spellcheck={false}
              autocomplete="off"
              placeholder="name@example.com or *@example.com"
              aria-invalid={message ? true : undefined}
              aria-describedby={`rule-err-${i}`}
              onInput={(e) => {
                const from = e.currentTarget.value;
                // A wildcard can only require dmarc, so switching to one resets the verdicts.
                const needsReset = from.trim().startsWith("*") && !(rule.require.length === 1 && rule.require[0] === "dmarc");
                setRule(i, { from, ...(needsReset ? { require: ["dmarc"] as RuleRow["require"] } : {}) });
              }}
              onBlur={() => setRule(i, { touched: true })}
            />
            <div class="le-verdicts" role="group" aria-label={`Required verdicts for rule ${i + 1}`}>
              {VERDICTS.map((v) => (
                <button
                  key={v}
                  type="button"
                  class="vchip"
                  aria-pressed={rule.require.includes(v)}
                  disabled={wildcard && v !== "dmarc"}
                  title={wildcard && v !== "dmarc" ? "Wildcards require dmarc only" : undefined}
                  onClick={() => setRule(i, { touched: true, require: rule.require.includes(v) ? rule.require.filter((x) => x !== v) : [...rule.require, v] })}
                >
                  {v}
                </button>
              ))}
            </div>
            <button
              type="button"
              class="btn btn-icon btn-ghost btn-sm"
              aria-label={`Remove rule ${i + 1}`}
              onClick={() => {
                onChange(rules.filter((_, n) => n !== i));
                toast(`Rule ${rule.from || "(empty)"} removed.`, () => onChange([...rules.slice(0, i), rule, ...rules.slice(i)]));
              }}
            >
              <Icon name="x" />
            </button>
            <p class="err" id={`rule-err-${i}`}>
              {message && (
                <>
                  <Icon name="alert" />
                  {message}
                </>
              )}
            </p>
          </div>
        );
      })}
      <div class="le-foot">
        <button type="button" class="btn btn-sm" disabled={full} onClick={() => onChange([...rules, { from: "", require: ["dmarc"], touched: false }])}>
          <Icon name="plus" />
          Add rule
        </button>
        <button type="button" class="btn btn-sm" disabled={full} onClick={onPaste}>
          Paste list
        </button>
        <span class="count">
          {rules.length} of {MAX_RULES}
        </span>
      </div>
    </div>
  );
}

function PasteRules({
  room,
  existing,
  onClose,
  onAdd,
}: {
  room: number;
  existing: RuleRow[];
  onClose: () => void;
  onAdd: (rules: { from: string; require: RuleRow["require"] }[]) => void;
}) {
  const [text, setText] = useState("");
  const parsed = parseBulk(text);
  // A pasted rule that repeats one already in the form is a problem to report, not to add twice.
  const have = new Set(existing.map((r) => r.from.trim().toLowerCase()));
  const fresh = parsed.rules.filter((r) => !have.has(r.from));
  const repeats = parsed.rules.length - fresh.length;
  const adding = fresh.slice(0, Math.max(0, room));
  const problems: ComponentChildren[] = parsed.problems.slice(0, 3);

  return (
    <Modal labelledBy="paste-title" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd(adding);
          onClose();
        }}
      >
        <div class="dlg-head">
          <h2 id="paste-title">Paste rules</h2>
          <p class="muted">One rule per line: a pattern, then verdicts. Lines starting with # are ignored. Wildcards default to dmarc.</p>
        </div>
        <div class="dlg-body">
          <label class="sr" for="bulk">
            Rules
          </label>
          <textarea
            class="textarea"
            id="bulk"
            rows={8}
            spellcheck={false}
            placeholder={"accounts@supplier.example.com dkim spf\n*@shop.example.com dmarc\n*"}
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <p class="field-hint" aria-live="polite">
            {adding.length ? `Adds ${adding.length === 1 ? "1 rule" : `${adding.length} rules`}.` : "Nothing to add yet."}
            {fresh.length > adding.length && ` ${fresh.length - adding.length} over the limit of ${MAX_RULES}.`}
            {repeats > 0 && ` ${repeats} already in the list.`}
            {problems.length > 0 && (
              <>
                <br />
                <span class="bad-text">
                  {parsed.problems.length === 1 ? "1 line is" : `${parsed.problems.length} lines are`} skipped: {problems.join("; ")}
                  {parsed.problems.length > 3 && "…"}
                </span>
              </>
            )}
          </p>
        </div>
        <div class="dlg-foot">
          <button class="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button class="btn btn-primary" type="submit" disabled={adding.length === 0}>
            Add rules
          </button>
        </div>
      </form>
    </Modal>
  );
}


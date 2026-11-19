import type { ComponentChildren } from "preact";
import type { LaneStatus, MessageListItem } from "../worker/admin/types.ts";
import { ApiRequestError } from "./api.ts";
import { refreshAll } from "./data.ts";
import { Icon, type IconName } from "./icons.tsx";
import { navigate, to } from "./router.ts";

/* ---------- Untrusted content ----------
 *
 * Anything from an email, or written by an agent about one, goes through these two components and
 * nowhere else. They only ever render text: nothing in this app sets innerHTML, and email-derived
 * fields (named untrusted_* in the API) must not be rendered any other way.
 */

export const UNTRUSTED_LABEL = "From the email, untrusted";

export function Untrusted({ text, label = UNTRUSTED_LABEL }: { text: string; label?: string }) {
  return (
    <div class="ut">
      <div class="ut-label">
        <Icon name="alert" />
        {label}
      </div>
      <pre class="ut-body">{text}</pre>
    </div>
  );
}

export function UntrustedInline({ text, truncate }: { text: string; truncate?: boolean }) {
  return (
    <span class={`uti${truncate ? " trunc" : ""}`} title={UNTRUSTED_LABEL}>
      {text}
    </span>
  );
}

/* ---------- Pills ---------- */

type Tone = "ok" | "warn" | "bad" | "info" | "idle";

export function Pill({ tone = "idle", plain, title, children }: { tone?: Tone; plain?: boolean; title?: string; children: ComponentChildren }) {
  const cls = ["pill", tone !== "idle" && `pill-${tone}`, plain && "pill-plain"].filter(Boolean).join(" ");
  return (
    <span class={cls} title={title}>
      {children}
    </span>
  );
}

export const LaneStatusPill = ({ status }: { status: LaneStatus }) =>
  status === "active" ? <Pill tone="ok">Active</Pill> : <Pill tone="warn">Paused</Pill>;

export const ProcessedPill = ({ processed }: { processed: unknown }) =>
  processed ? <Pill>Processed</Pill> : <Pill tone="info">Unprocessed</Pill>;

export function MessageFlags({ message }: { message: Pick<MessageListItem, "is_test" | "keep" | "transform_error_count"> }) {
  return (
    <span class="flags">
      {message.is_test && <Pill plain>Test</Pill>}
      {message.keep && (
        <Pill plain title="Exempt from retention">
          Kept
        </Pill>
      )}
      {message.transform_error_count > 0 && (
        <Pill tone="bad" plain>
          Transform error
        </Pill>
      )}
    </span>
  );
}

/* ---------- Layout ---------- */

export function PageHead({
  title,
  sub,
  actions,
  crumb,
}: {
  title: ComponentChildren;
  sub?: ComponentChildren;
  actions?: ComponentChildren;
  crumb?: ComponentChildren;
}) {
  return (
    <div class="page-head">
      <div class="titles">
        {crumb && <div class="crumb">{crumb}</div>}
        <h1>{title}</h1>
        {sub && <p class="sub">{sub}</p>}
      </div>
      {actions && <div class="actions">{actions}</div>}
    </div>
  );
}

export function Panel({
  title,
  meta,
  action,
  flush,
  children,
}: {
  title?: ComponentChildren;
  meta?: ComponentChildren;
  action?: ComponentChildren;
  flush?: boolean;
  children: ComponentChildren;
}) {
  return (
    <section class="panel">
      {(title || meta || action) && (
        <div class="panel-head">
          <h2>{title}</h2>
          {meta && <span class="meta">{meta}</span>}
          {action}
        </div>
      )}
      <div class={`panel-body${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}

export function Empty({
  icon,
  title,
  text,
  action,
  tight,
}: {
  icon: IconName;
  title: string;
  text: string;
  action?: ComponentChildren;
  tight?: boolean;
}) {
  return (
    <div class={`empty${tight ? " tight" : ""}`}>
      <span class="ic">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

export function NotFound() {
  return (
    <Empty
      icon="search"
      title="Nothing at this address"
      text="The lane, message or page may have been deleted."
      action={
        <a class="btn" href={to.overview()}>
          Back to overview
        </a>
      }
    />
  );
}

/** A failed load. A 404 is a missing thing, not an outage. */
export function LoadError({ error, what }: { error: ApiRequestError; what: string }) {
  if (error.status === 404) return <NotFound />;
  if (error.status === 401) return null; // the session banner already says it
  return (
    <div class="state-page">
      <div class="state-card">
        <span class="ic ic-bad">
          <Icon name="alert" />
        </span>
        <h3>{what} couldn’t be loaded</h3>
        <p class="muted">Nothing has changed on the server.</p>
        <Untrusted text={error.message} label="Error text, may include values from the email" />
        <div class="row">
          <button class="btn btn-primary" type="button" onClick={refreshAll}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <table class="table" aria-busy="true">
      <tbody>
        {Array.from({ length: rows }, (_, i) => (
          <tr key={i}>
            <td>
              <span class="skel w-md" />
            </td>
            <td>
              <span class="skel w-sm" />
            </td>
            <td>
              <span class="skel w-lg" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PageSkeleton() {
  return (
    <div class="stack" aria-busy="true">
      <section class="panel">
        <TableSkeleton />
      </section>
      <section class="panel">
        <TableSkeleton />
      </section>
    </div>
  );
}

/** A row that opens its target on click, unless the click was on something interactive inside it. */
export const rowLink = (hash: string) => (e: MouseEvent) => {
  if ((e.target as HTMLElement).closest("a,button,input,select")) return;
  navigate(hash);
};

/* ---------- Forms ---------- */

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string;
  children: ComponentChildren;
}) {
  return (
    <div class={`field${error ? " invalid" : ""}`} data-field={id}>
      <label for={`i-${id}`}>{label}</label>
      {hint && (
        <p class="hint" id={`h-${id}`}>
          {hint}
        </p>
      )}
      {children}
      <p class="err" id={`e-${id}`} aria-live="polite">
        {error && (
          <>
            <Icon name="alert" />
            {error}
          </>
        )}
      </p>
    </div>
  );
}

/** For controls made of several inputs, where a <label for> has nothing single to point at. */
export function FieldGroup({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string;
  children: ComponentChildren;
}) {
  return (
    <div class={`field${error ? " invalid" : ""}`} data-field={id} role="group" aria-labelledby={`l-${id}`}>
      <span class="label" id={`l-${id}`}>
        {label}
      </span>
      {hint && (
        <p class="hint" id={`h-${id}`}>
          {hint}
        </p>
      )}
      {children}
      <p class="err" id={`e-${id}`} aria-live="polite">
        {error && (
          <>
            <Icon name="alert" />
            {error}
          </>
        )}
      </p>
    </div>
  );
}

export const describedBy = (id: string, hasHint: boolean): string => (hasHint ? `h-${id} e-${id}` : `e-${id}`);

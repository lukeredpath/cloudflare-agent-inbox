import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { createStore, useStore } from "./store.ts";

/** A native modal <dialog>: focus is trapped, Esc closes it, and the page behind is inert. */
export function Modal({
  children,
  onClose,
  labelledBy,
  label,
  class: className = "dlg",
  dismissOnBackdrop,
}: {
  children: ComponentChildren;
  onClose: () => void;
  labelledBy?: string;
  label?: string;
  class?: string;
  /** Clicking the dimmed area closes it. Off for dialogs that hold a form. */
  dismissOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    const handle = () => closeRef.current();
    dialog.addEventListener("close", handle);
    return () => {
      dialog.removeEventListener("close", handle);
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      class={className}
      aria-labelledby={labelledBy}
      aria-label={label}
      onClick={dismissOnBackdrop ? (e) => e.target === ref.current && ref.current?.close() : undefined}
    >
      {children}
    </dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  /** One line per consequence: what will actually happen. */
  items?: ComponentChildren[];
  note?: ComponentChildren;
  confirm: string;
  /** Deleting something large asks for its name to be typed. */
  typeToConfirm?: string;
}

interface Pending {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

const pending = createStore<Pending | null>(null);

/** Resolves true only when the person confirms. Closing the dialog any other way resolves false. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  pending.get()?.resolve(false);
  return new Promise((resolve) => pending.set({ options, resolve }));
}

function ConfirmDialog({ request }: { request: Pending }) {
  const { options } = request;
  const [typed, setTyped] = useState("");
  const settle = (ok: boolean) => {
    request.resolve(ok);
    if (pending.get() === request) pending.set(null);
  };
  const ready = !options.typeToConfirm || typed === options.typeToConfirm;
  return (
    <Modal labelledBy="confirm-title" onClose={() => settle(false)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) settle(true);
        }}
      >
        <div class="dlg-head">
          <h2 id="confirm-title">{options.title}</h2>
        </div>
        <div class="dlg-body">
          {options.items && options.items.length > 0 && (
            <div class="consequence">
              <p class="muted">This will:</p>
              <ul>
                {options.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {options.note && <p class="muted">{options.note}</p>}
          {options.typeToConfirm && (
            <div class="field">
              <label for="confirm-type">
                Type <code>{options.typeToConfirm}</code> to confirm
              </label>
              <input
                class="input mono"
                id="confirm-type"
                autocomplete="off"
                spellcheck={false}
                value={typed}
                onInput={(e) => setTyped(e.currentTarget.value)}
              />
            </div>
          )}
        </div>
        <div class="dlg-foot">
          <button class="btn" type="button" onClick={() => settle(false)}>
            Cancel
          </button>
          <button class="btn btn-danger" type="submit" disabled={!ready}>
            {options.confirm}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DialogHost() {
  const request = useStore(pending);
  return request ? <ConfirmDialog key={request.options.title} request={request} /> : null;
}

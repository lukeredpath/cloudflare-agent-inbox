import { useEffect } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { createStore, useStore } from "./store.ts";

interface ToastItem {
  id: number;
  message: string;
  undo?: () => void;
}

const toasts = createStore<ToastItem[]>([]);
let next = 1;

const dismiss = (id: number) => toasts.set(toasts.get().filter((t) => t.id !== id));

/** A short confirmation. Pass `undo` only for changes that can really be reversed. */
export function toast(message: string, undo?: () => void): void {
  toasts.set([...toasts.get(), { id: next++, message, undo }]);
}

function ToastView({ item }: { item: ToastItem }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(item.id), item.undo ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [item.id]);
  return (
    <div class="toast" role="status">
      <p>{item.message}</p>
      {item.undo && (
        <button
          type="button"
          onClick={() => {
            item.undo?.();
            dismiss(item.id);
          }}
        >
          Undo
        </button>
      )}
      <button type="button" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
        <Icon name="x" />
      </button>
    </div>
  );
}

export function Toasts() {
  const items = useStore(toasts);
  return (
    <div class="toasts" aria-live="polite">
      {items.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}

export async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`);
  } catch {
    toast("The browser blocked copying. Select the text and copy it manually.");
  }
}

import { useEffect, useState } from "preact/hooks";
import type { LaneListItem, SessionView } from "../worker/admin/types.ts";
import { api } from "./api.ts";

type Loaded<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

function useApi<T>(path: string): Loaded<T> {
  const [result, setResult] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    api<T>(path).then(
      (data) => live && setResult({ state: "ready", data }),
      (e: Error) => live && setResult({ state: "error", message: e.message }),
    );
    return () => {
      live = false;
    };
  }, [path]);
  return result;
}

// A placeholder shell: the real screens come from the design.
export function App() {
  const session = useApi<SessionView>("/api/session");
  const lanes = useApi<LaneListItem[]>("/api/lanes");

  return (
    <main>
      <h1>Agent Inbox</h1>
      <p>{session.state === "ready" ? `Signed in${session.data.email ? ` as ${session.data.email}` : ""}.` : "Checking your session…"}</p>
      {lanes.state === "error" && <p role="alert">{lanes.message}</p>}
      {lanes.state === "ready" && (
        <ul>
          {lanes.data.map((l) => (
            <li key={l.slug}>
              {l.slug} ({l.status}): {l.unprocessedCount} unprocessed of {l.messageCount}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

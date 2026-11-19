import { useEffect, useState } from "preact/hooks";
import { api, ApiRequestError } from "./api.ts";
import { createStore, useStore } from "./store.ts";

const version = createStore(0);

/** Reload everything on screen. Called after any change, so counts and lists never go stale. */
export const refreshAll = (): void => version.set(version.get() + 1);

export interface Resource<T> {
  data: T | undefined;
  error: ApiRequestError | undefined;
  /** True while a first load, or a reload after a change, is in flight. */
  loading: boolean;
}

interface Loaded<T> extends Resource<T> {
  path: string | null;
}

/** Loads a JSON endpoint. Old data stays visible while a reload runs, but never from a different path. */
export function useResource<T>(path: string | null): Resource<T> {
  const tick = useStore(version);
  const [state, setState] = useState<Loaded<T>>({ path: null, data: undefined, error: undefined, loading: true });

  useEffect(() => {
    if (path === null) return;
    let live = true;
    setState((prev) => ({ path, data: prev.path === path ? prev.data : undefined, error: undefined, loading: true }));
    api<T>(path).then(
      (data) => live && setState({ path, data, error: undefined, loading: false }),
      (error: unknown) =>
        live &&
        setState((prev) => ({
          path,
          data: prev.path === path ? prev.data : undefined,
          error: error instanceof ApiRequestError ? error : new ApiRequestError(0, "Something went wrong."),
          loading: false,
        })),
    );
    return () => {
      live = false;
    };
  }, [path, tick]);

  return state.path === path ? state : { data: undefined, error: undefined, loading: true };
}

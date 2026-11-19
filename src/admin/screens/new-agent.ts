import { createStore } from "../store.ts";
import { navigate, to } from "../router.ts";

/** Asked for from the shortcut and the palette; the Agents screen opens its dialog when it sees this. */
export const newAgentRequested = createStore(false);

export function requestNewAgent(): void {
  newAgentRequested.set(true);
  navigate(to.agents());
}

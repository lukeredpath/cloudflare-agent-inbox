import { useEffect, useState } from "preact/hooks";

import { parseRoute, type Route } from "./route-model.ts";

export { parseRoute, type Route };

/** Where each screen lives. Hash routes need nothing from the server, so Access and the asset fallback stay out of it. */
export const to = {
  overview: () => "#overview",
  messages: (filter: { lane?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (filter.lane) q.set("lane", filter.lane);
    if (filter.status && filter.status !== "all") q.set("status", filter.status);
    const s = q.toString();
    return `#messages${s ? `?${s}` : ""}`;
  },
  message: (id: string) => `#messages/${id}`,
  agents: () => "#agents",
  rejections: () => "#rejections",
  newLane: () => "#lanes/new",
  lane: (slug: string) => `#lanes/${slug}`,
  editLane: (slug: string) => `#lanes/${slug}/edit`,
};

export const navigate = (hash: string): void => {
  location.hash = hash;
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

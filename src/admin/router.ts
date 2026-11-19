import { useEffect, useState } from "preact/hooks";

export type Route =
  | { name: "overview" }
  | { name: "messages"; lane: string; status: string }
  | { name: "message"; id: string }
  | { name: "agents" }
  | { name: "rejections" }
  | { name: "new-lane" }
  | { name: "lane"; slug: string }
  | { name: "edit-lane"; slug: string }
  | { name: "not-found" };

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const [first = "", rest = ""] = [path.split("/")[0], path.split("/").slice(1).join("/")];
  switch (first) {
    case "":
    case "overview":
      return { name: "overview" };
    case "messages":
      return rest ? { name: "message", id: rest } : { name: "messages", lane: params.get("lane") ?? "", status: params.get("status") ?? "all" };
    case "agents":
      return { name: "agents" };
    case "rejections":
      return { name: "rejections" };
    case "lanes":
      if (rest === "new") return { name: "new-lane" };
      if (rest.endsWith("/edit")) return { name: "edit-lane", slug: rest.slice(0, -5) };
      return rest ? { name: "lane", slug: rest } : { name: "not-found" };
    default:
      return { name: "not-found" };
  }
}

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

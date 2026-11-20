/* The admin's routes as pure rules (no DOM), so they can be tested. router.ts wires them to the location hash. */

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

export const APP_TITLE = "Agent Inbox admin";

/** What the browser tab and history say. Never email text: only names the operator chose and fixed words. */
export function routeTitle(route: Route): string {
  switch (route.name) {
    case "overview":
      return "Overview";
    case "messages":
      return "Messages";
    case "message":
      return "Message";
    case "agents":
      return "Agents";
    case "rejections":
      return "Rejections";
    case "new-lane":
      return "New lane";
    case "lane":
      return route.slug;
    case "edit-lane":
      return `Edit ${route.slug}`;
    case "not-found":
      return "Not found";
  }
}

/** Which main-menu entry is current, or "" when none is (an unknown address belongs to no screen). */
export function currentScreen(route: Route): string {
  switch (route.name) {
    case "message":
    case "messages":
      return "messages";
    case "agents":
    case "rejections":
      return route.name;
    case "not-found":
      return "";
    default:
      return "overview";
  }
}

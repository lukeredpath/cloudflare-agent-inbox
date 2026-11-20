import { describe, expect, it } from "vitest";
import { currentScreen, parseRoute, routeTitle } from "../src/admin/route-model.ts";

describe("admin routes", () => {
  it("gives every screen its own title", () => {
    const titles = ["#overview", "#messages", "#messages/01ABC", "#agents", "#rejections", "#lanes/new", "#lanes/receipts", "#lanes/receipts/edit", "#nope"].map((h) =>
      routeTitle(parseRoute(h)),
    );
    expect(titles).toEqual(["Overview", "Messages", "Message", "Agents", "Rejections", "New lane", "receipts", "Edit receipts", "Not found"]);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("names a message only by the word Message, never by its subject", () => {
    expect(routeTitle(parseRoute("#messages/01ABC"))).toBe("Message");
  });

  it("marks no main-menu entry current on an unknown address", () => {
    expect(currentScreen(parseRoute("#nope"))).toBe("");
    expect(currentScreen(parseRoute("#overview"))).toBe("overview");
    expect(currentScreen(parseRoute("#lanes/new"))).toBe("overview");
    expect(currentScreen(parseRoute("#messages/01ABC"))).toBe("messages");
    expect(currentScreen(parseRoute("#rejections"))).toBe("rejections");
  });
});

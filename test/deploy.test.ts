import { describe, expect, it } from "vitest";
import { parseDatabaseList, planDeploy } from "../scripts/deploy";

describe("parseDatabaseList", () => {
  it("reads wrangler's JSON list", () => {
    expect(parseDatabaseList('[{"uuid":"u1","name":"one"},{"uuid":"u2","name":"two"}]')).toEqual([
      { uuid: "u1", name: "one" },
      { uuid: "u2", name: "two" },
    ]);
    expect(parseDatabaseList("[]")).toEqual([]);
  });

  it("returns null for anything that is not a list, and ignores malformed entries", () => {
    expect(parseDatabaseList("not json")).toBeNull();
    expect(parseDatabaseList('{"name":"x"}')).toBeNull();
    expect(parseDatabaseList('[{"name":"ok"},{"uuid":"no-name"},null,3]')).toEqual([{ name: "ok" }]);
  });
});

describe("planDeploy", () => {
  it("migrates before deploying when the database exists, so new code never meets an old schema", () => {
    expect(planDeploy([{ name: "inbox" }, { name: "other" }], "inbox").steps).toEqual(["migrate", "deploy"]);
  });

  it("deploys first on a fresh account so the database is provisioned, then migrates", () => {
    expect(planDeploy([{ name: "other" }], "inbox").steps).toEqual(["deploy", "migrate"]);
    expect(planDeploy([], "inbox").steps).toEqual(["deploy", "migrate"]);
  });

  it("assumes the database exists when the lookup failed, and says so", () => {
    const plan = planDeploy(null, "inbox");
    expect(plan.steps).toEqual(["migrate", "deploy"]);
    expect(plan.note).toMatch(/could not list/);
  });

  it("matches the name exactly", () => {
    expect(planDeploy([{ name: "inbox-staging" }], "inbox").steps).toEqual(["deploy", "migrate"]);
  });
});

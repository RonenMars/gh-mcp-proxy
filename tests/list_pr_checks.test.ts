import { describe, expect, it } from "vitest";
import { listPrChecksTool } from "../src/tools/list_pr_checks.js";
import { mockFetch } from "./test_helpers.js";

describe("list_pr_checks", () => {
  it("combines check runs and legacy statuses", async () => {
    mockFetch([
      { body: { check_runs: [{ name: "build", status: "completed", conclusion: "success", html_url: "https://checks" }] } },
      { body: { statuses: [{ context: "ci/legacy", state: "success", target_url: "https://status" }] } }
    ]);

    await expect(listPrChecksTool.handler({ owner: "RonenMars", repo: "repo", ref: "abc" }, "token")).resolves.toEqual([
      { name: "build", kind: "check_run", status: "completed", conclusion: "success", url: "https://checks" },
      { name: "ci/legacy", kind: "status", status: "success", conclusion: "success", url: "https://status" }
    ]);
  });
});

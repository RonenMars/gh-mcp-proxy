import { describe, expect, it } from "vitest";
import { getWorkflowRunStatusTool } from "../src/tools/get_workflow_run_status.js";
import { mockFetch } from "./test_helpers.js";

describe("get_workflow_run_status", () => {
  it("fetches runs and jobs with pagination", async () => {
    mockFetch([
      {
        body: { workflow_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "failure" }] },
        headers: { link: '<https://api.github.com/page2>; rel="next"' }
      },
      { body: { workflow_runs: [{ id: 2, name: "Lint", status: "completed", conclusion: "success" }] } },
      { body: { jobs: [{ name: "test", conclusion: "failure" }] } },
      { body: { jobs: [{ name: "lint", conclusion: "success" }] } }
    ]);

    await expect(getWorkflowRunStatusTool.handler({ owner: "o", repo: "r", sha: "abc" }, "token")).resolves.toEqual([
      {
        workflow_name: "CI",
        run_id: 1,
        status: "completed",
        conclusion: "failure",
        jobs: [{ name: "test", conclusion: "failure" }]
      },
      {
        workflow_name: "Lint",
        run_id: 2,
        status: "completed",
        conclusion: "success",
        jobs: [{ name: "lint", conclusion: "success" }]
      }
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { createIssueWithLabelsAndAssigneesTool } from "../src/tools/create_issue_with_labels_and_assignees.js";
import { mockFetch } from "./test_helpers.js";

describe("create_issue_with_labels_and_assignees", () => {
  it("creates an issue and returns number and url", async () => {
    const fetchMock = mockFetch([
      { body: { number: 42, html_url: "https://github.com/o/r/issues/42" } }
    ]);

    await expect(createIssueWithLabelsAndAssigneesTool.handler({
      owner: "o",
      repo: "r",
      title: "new issue",
      labels: ["needs-triage"],
      assignees: ["ronen"]
    }, "token")).resolves.toEqual({
      number: 42,
      url: "https://github.com/o/r/issues/42"
    });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });
});

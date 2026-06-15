import { describe, expect, it } from "vitest";
import { getCommitDiffTool } from "../src/tools/get_commit_diff.js";
import { mockFetch } from "./test_helpers.js";

describe("get_commit_diff", () => {
  it("fetches metadata as JSON and diff as text", async () => {
    const fetchMock = mockFetch([
      { body: { sha: "abc", commit: { message: "fix bug" } } },
      { body: "diff --git a/a b/a" }
    ]);

    await expect(getCommitDiffTool.handler({ owner: "a", repo: "b", sha: "abc" }, "token")).resolves.toEqual({
      sha: "abc",
      message: "fix bug",
      diff: "diff --git a/a b/a"
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ accept: "application/vnd.github.diff" });
  });
});

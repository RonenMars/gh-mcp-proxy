import { describe, expect, it } from "vitest";
import { bulkFileReadTool } from "../src/tools/bulk_file_read.js";
import { mockFetch } from "./test_helpers.js";

describe("bulk_file_read", () => {
  it("returns per-file errors without failing the batch", async () => {
    mockFetch([
      { body: { content: Buffer.from("hello").toString("base64"), encoding: "base64" } },
      { status: 404, body: { message: "Not Found" } }
    ]);

    await expect(bulkFileReadTool.handler({
      files: [
        { owner: "a", repo: "b", path: "README.md" },
        { owner: "a", repo: "b", path: "missing.md" }
      ]
    }, "token")).resolves.toEqual([
      { owner: "a", repo: "b", path: "README.md", content: "hello" },
      { owner: "a", repo: "b", path: "missing.md", content: "", error: expect.stringContaining("GitHub API HTTP 404") }
    ]);
  });
});

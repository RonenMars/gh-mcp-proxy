import { z } from "zod";
import { GitHubApi } from "../github.js";

const inputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  sha: z.string()
});

export const getCommitDiffTool = {
  name: "get_commit_diff",
  description: "Fetch commit metadata and raw unified diff for a GitHub commit.",
  inputSchema: {
    type: "object",
    required: ["owner", "repo", "sha"],
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      sha: { type: "string" }
    }
  },
  async handler(args: unknown, token = process.env.GITHUB_TOKEN) {
    const { owner, repo, sha } = inputSchema.parse(args);
    const api = new GitHubApi(token);
    const path = `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`;
    const [metadata, diff] = await Promise.all([
      api.getJson<{ sha: string; commit: { message: string } }>(path),
      api.getText(path, "application/vnd.github.diff")
    ]);

    return {
      sha: metadata.sha,
      message: metadata.commit.message,
      diff
    };
  }
};

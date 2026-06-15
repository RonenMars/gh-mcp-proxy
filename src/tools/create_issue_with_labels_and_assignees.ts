import { z } from "zod";
import { GitHubApi } from "../github.js";

const inputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  title: z.string(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  milestone: z.number().optional()
});

export const createIssueWithLabelsAndAssigneesTool = {
  name: "create_issue_with_labels_and_assignees",
  description: "Create a GitHub issue with labels, assignees, and optional milestone in one request.",
  inputSchema: {
    type: "object",
    required: ["owner", "repo", "title"],
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
      assignees: { type: "array", items: { type: "string" } },
      milestone: { type: "number" }
    }
  },
  async handler(args: unknown, token = process.env.GITHUB_TOKEN) {
    const { owner, repo, ...body } = inputSchema.parse(args);
    const api = new GitHubApi(token);
    const issue = await api.postJson<{ number: number; html_url: string }>(
      `/repos/${owner}/${repo}/issues`,
      body
    );
    return {
      number: issue.number,
      url: issue.html_url
    };
  }
};

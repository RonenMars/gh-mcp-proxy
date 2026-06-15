import { z } from "zod";
import { GitHubApi } from "../github.js";

const inputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string()
});

export const listPrChecksTool = {
  name: "list_pr_checks",
  description: "List GitHub check runs and legacy commit statuses for a commit SHA or branch.",
  inputSchema: {
    type: "object",
    required: ["owner", "repo", "ref"],
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      ref: { type: "string" }
    }
  },
  async handler(args: unknown, token = process.env.GITHUB_TOKEN) {
    const { owner, repo, ref } = inputSchema.parse(args);
    const api = new GitHubApi(token);
    const encodedRef = encodeURIComponent(ref);
    const [checkRuns, statuses] = await Promise.all([
      api.getJson<{ check_runs?: Array<{ name: string; status: string; conclusion: string | null; html_url?: string }> }>(
        `/repos/${owner}/${repo}/commits/${encodedRef}/check-runs`
      ),
      api.getJson<{ statuses?: Array<{ context: string; state: string; target_url?: string }> }>(
        `/repos/${owner}/${repo}/commits/${encodedRef}/status`
      )
    ]);

    return [
      ...(checkRuns.check_runs ?? []).map((run) => ({
        name: run.name,
        kind: "check_run",
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url ?? null
      })),
      ...(statuses.statuses ?? []).map((status) => ({
        name: status.context,
        kind: "status",
        status: status.state,
        conclusion: status.state,
        url: status.target_url ?? null
      }))
    ];
  }
};

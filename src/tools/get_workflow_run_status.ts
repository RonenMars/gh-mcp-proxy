import { z } from "zod";
import { GitHubApi } from "../github.js";

const inputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  sha: z.string()
});

export const getWorkflowRunStatusTool = {
  name: "get_workflow_run_status",
  description: "List workflow runs for a commit SHA with per-job conclusions.",
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
    const runs = await api.paginate<WorkflowRun>(
      `/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
      "workflow_runs"
    );

    return Promise.all(runs.map(async (run) => {
      const jobs = await api.paginate<{ name: string; conclusion: string | null }>(
        `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
        "jobs"
      );
      return {
        workflow_name: run.name,
        run_id: run.id,
        status: run.status,
        conclusion: run.conclusion,
        jobs: jobs.map((job) => ({
          name: job.name,
          conclusion: job.conclusion
        }))
      };
    }));
  }
};

type WorkflowRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
};

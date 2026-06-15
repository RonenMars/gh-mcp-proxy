import { z } from "zod";
import { GitHubApi } from "../github.js";

const inputSchema = z.object({
  files: z.array(z.object({
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
    ref: z.string().optional()
  }))
});

export const bulkFileReadTool = {
  name: "bulk_file_read",
  description: "Read multiple GitHub repository files in one call with per-file errors.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          required: ["owner", "repo", "path"],
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            path: { type: "string" },
            ref: { type: "string" }
          }
        }
      }
    }
  },
  async handler(args: unknown, token = process.env.GITHUB_TOKEN) {
    const { files } = inputSchema.parse(args);
    const api = new GitHubApi(token);

    return Promise.all(files.map(async (file) => {
      try {
        const query = file.ref ? `?ref=${encodeURIComponent(file.ref)}` : "";
        const result = await api.getJson<{ content?: string; encoding?: string }>(
          `/repos/${file.owner}/${file.repo}/contents/${encodePath(file.path)}${query}`
        );
        if (result.encoding !== "base64" || !result.content) {
          throw new Error("GitHub content response did not include base64 file content");
        }
        return {
          owner: file.owner,
          repo: file.repo,
          path: file.path,
          content: Buffer.from(result.content.replace(/\n/g, ""), "base64").toString("utf8")
        };
      } catch (error) {
        return {
          owner: file.owner,
          repo: file.repo,
          path: file.path,
          content: "",
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }));
  }
};

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

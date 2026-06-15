import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

// Real Docker Compose smoke test: starts BOTH the upstream official
// github-mcp-server and the proxy via `docker compose up`, then hits the proxy
// endpoint. Unlike integration.test.ts (in-process mock upstream), this exercises
// the actual Dockerfile, docker-compose.yml wiring, and upstream image.
//
// Opt-in only — it needs Docker running and a real GITHUB_PERSONAL_ACCESS_TOKEN.
// Enable with: RUN_COMPOSE_TEST=1 npm test
const enabled = process.env.RUN_COMPOSE_TEST === "1";
const describeCompose = enabled ? describe : describe.skip;

if (!enabled) {
  // Make the skip visible rather than silently passing zero assertions.
  console.log("[compose.test] skipped — set RUN_COMPOSE_TEST=1 (needs Docker + GITHUB_PERSONAL_ACCESS_TOKEN) to run");
}

describeCompose("docker compose smoke", () => {
  afterAll(async () => {
    await run("docker", ["compose", "down", "-v"], { cwd: process.cwd() }).catch(() => {});
  });

  it("brings up both containers and merges tools through the proxy", async () => {
    await run("docker", ["compose", "up", "-d", "--build"], { cwd: process.cwd() });

    const proxyAuth = process.env.PROXY_AUTH_TOKEN;
    const tools = await pollToolsList(proxyAuth);
    const names = tools.map((tool: { name: string }) => tool.name);

    // At least one upstream tool must appear alongside the custom tools.
    expect(names).toContain("list_pr_checks");
    expect(names.some((name: string) => !name.startsWith("list_pr_checks") && name.includes("_"))).toBe(true);
    expect(names.length).toBeGreaterThan(5);
  }, 180_000);
});

async function pollToolsList(proxyAuth?: string): Promise<Array<{ name: string }>> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8082", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(proxyAuth ? { authorization: `Bearer ${proxyAuth}` } : {})
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      const json = await response.json() as { result?: { tools?: Array<{ name: string }> } };
      if (json.result?.tools?.length) {
        return json.result.tools;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(3000);
  }
  throw new Error(`Proxy did not return tools within timeout: ${lastError}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe("proxy integration", () => {
  it("requires auth, merges tools/list, and passes upstream tool calls through", async () => {
    const upstream = http.createServer(async (req, res) => {
      const body = await readBody(req);
      const request = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      if (request.method === "tools/list") {
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: [{ name: "upstream_tool", description: "from upstream", inputSchema: {} }] }
        }));
        return;
      }
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: "upstream result" }] }
      }));
    });
    servers.push(upstream);
    await listen(upstream, 0);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = createServer({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      proxyAuthToken: "proxy-secret"
    });
    servers.push(proxy);
    await listen(proxy, 0);
    const proxyPort = (proxy.address() as { port: number }).port;

    const unauthorized = await callProxy(proxyPort, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(unauthorized.error?.message).toBe("Unauthorized");

    const tools = await callProxy(proxyPort, { jsonrpc: "2.0", id: 2, method: "tools/list" }, "proxy-secret");
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining([
      "upstream_tool",
      "list_pr_checks",
      "bulk_file_read",
      "get_commit_diff",
      "create_issue_with_labels_and_assignees",
      "get_workflow_run_status"
    ]));

    const upstreamCall = await callProxy(proxyPort, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "upstream_tool", arguments: {} }
    }, "proxy-secret");
    expect(upstreamCall.result.content[0].text).toBe("upstream result");
  });

  it("streams SSE upstream responses through unchanged", async () => {
    const upstream = http.createServer(async (req, res) => {
      await readBody(req);
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
      res.write("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n");
      res.end();
    });
    servers.push(upstream);
    await listen(upstream, 0);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = createServer({ upstreamUrl: `http://127.0.0.1:${upstreamPort}` });
    servers.push(proxy);
    await listen(proxy, 0);
    const proxyPort = (proxy.address() as { port: number }).port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("mcp-session-id")).toBe("sess-1");
    expect(await response.text()).toContain("data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}");
  });

  it("acknowledges notifications with 202 and no body", async () => {
    let forwarded = false;
    const upstream = http.createServer(async (req, res) => {
      await readBody(req);
      forwarded = true;
      res.writeHead(202);
      res.end();
    });
    servers.push(upstream);
    await listen(upstream, 0);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = createServer({ upstreamUrl: `http://127.0.0.1:${upstreamPort}` });
    servers.push(proxy);
    await listen(proxy, 0);
    const proxyPort = (proxy.address() as { port: number }).port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(forwarded).toBe(true);
  });

  it("rejects unauthorized callers before parsing the body", async () => {
    const proxy = createServer({ upstreamUrl: "http://127.0.0.1:1", proxyAuthToken: "proxy-secret" });
    servers.push(proxy);
    await listen(proxy, 0);
    const proxyPort = (proxy.address() as { port: number }).port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json"
    });
    const json = await response.json();
    expect(json.error.message).toBe("Unauthorized");
  });
});

async function callProxy(port: number, body: unknown, token?: string): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return response.json();
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

const servers: http.Server[] = [];

const CHALLENGE =
  'Bearer resource_metadata="https://example.test/.well-known/oauth-protected-resource"';

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe("proxy integration", () => {
  it("challenges tokenless callers, merges tools/list, and passes upstream tool calls through", async () => {
    const upstream = http.createServer(async (req, res) => {
      const body = await readBody(req);
      const request = JSON.parse(body);
      // Mirror the real github-mcp-server, which answers a tokenless request with
      // a 401 carrying the challenge that starts the OAuth flow.
      if (!req.headers.authorization) {
        res.writeHead(401, { "content-type": "text/plain", "www-authenticate": CHALLENGE });
        res.end("Unauthorized");
        return;
      }
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
      proxyAuthToken: "proxy-secret",
      upstreamAuthToken: "upstream-pat"
    });
    servers.push(proxy);
    await listen(proxy, 0);
    const proxyPort = (proxy.address() as { port: number }).port;

    // The challenge must reach the client as a real 401 with its WWW-Authenticate
    // header intact — collapsed into a 200 JSON-RPC error, a client has no signal
    // that it should authenticate.
    const unauthorized = await fetch(`http://127.0.0.1:${proxyPort}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(CHALLENGE);

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

  it("parses SSE upstream responses into JSON and echoes the session header", async () => {
    // The official github-mcp-server answers every request as a single-message
    // SSE frame; the proxy must parse the data line out and return JSON so it can
    // merge tools and route. Session id is echoed back for continuity.
    const upstream = http.createServer(async (req, res) => {
      await readBody(req);
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
      res.write("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-03-26\"}}\n\n");
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
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("mcp-session-id")).toBe("sess-1");
    const json = await response.json();
    expect(json).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26" } });
    expect(json._responseHeaders).toBeUndefined();
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

  it("relays OAuth discovery GETs to upstream instead of answering 405", async () => {
    // Answering every non-POST with 405 killed the MCP handshake at its first
    // step: a client fetches the protected-resource metadata over GET before it
    // has any token to send.
    const upstream = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/.well-known/oauth-protected-resource") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          resource: "https://example.test/",
          authorization_servers: ["https://github.com/login/oauth"]
        }));
        return;
      }
      res.writeHead(404);
      res.end();
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

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/.well-known/oauth-protected-resource`
    );
    expect(response.status).toBe(200);
    expect((await response.json()).authorization_servers).toEqual([
      "https://github.com/login/oauth"
    ]);
  });

  it("sends the static upstream token for PROXY_AUTH_TOKEN callers and the caller's own token otherwise", async () => {
    // The whole of the "accept both" model in one assertion: a caller holding the
    // shared secret acts as the proxy, everyone else acts as themselves.
    const seen: Array<string | undefined> = [];
    const upstream = http.createServer(async (req, res) => {
      await readBody(req);
      seen.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    });
    servers.push(upstream);
    await listen(upstream, 0);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = createServer({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      proxyAuthToken: "proxy-secret",
      upstreamAuthToken: "upstream-pat"
    });
    servers.push(proxy);
    await listen(proxy, 0);
    const proxyPort = (proxy.address() as { port: number }).port;

    await callProxy(proxyPort, { jsonrpc: "2.0", id: 1, method: "initialize" }, "proxy-secret");
    await callProxy(proxyPort, { jsonrpc: "2.0", id: 2, method: "initialize" }, "gho_caller");
    expect(seen).toEqual(["Bearer upstream-pat", "Bearer gho_caller"]);
  });

  it("does not serve custom tools to tokenless callers", async () => {
    // Custom tools are answered inside the proxy, so serving one without a token
    // would spend the proxy's own GITHUB_TOKEN on an anonymous caller. The call
    // has to fall through to upstream and come back as a challenge.
    let reachedUpstream = false;
    const upstream = http.createServer(async (req, res) => {
      await readBody(req);
      reachedUpstream = true;
      res.writeHead(401, { "content-type": "text/plain", "www-authenticate": CHALLENGE });
      res.end("Unauthorized");
    });
    servers.push(upstream);
    await listen(upstream, 0);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = createServer({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      proxyAuthToken: "proxy-secret",
      githubToken: "gho_proxy_secret_token"
    });
    servers.push(proxy);
    await listen(proxy, 0);
    const proxyPort = (proxy.address() as { port: number }).port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "bulk_file_read", arguments: { files: [] } }
      })
    });
    expect(response.status).toBe(401);
    expect(reachedUpstream).toBe(true);
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

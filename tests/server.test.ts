import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/server.js";
import { JsonRpcRequest, JsonRpcResponse, UpstreamClient } from "../src/upstream.js";
import { mockFetch } from "./test_helpers.js";

class MockUpstream extends UpstreamClient {
  constructor(private readonly response: JsonRpcResponse) {
    super("http://example.invalid");
  }

  override async forward(_request: JsonRpcRequest, _headers: Headers): Promise<JsonRpcResponse> {
    return this.response;
  }
}

describe("server tools/list", () => {
  it("merges upstream and custom tools", async () => {
    const result = await handleRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      new Headers(),
      new MockUpstream({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "upstream_tool", description: "upstream", inputSchema: {} }] }
      })
    );

    expect(result.result).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "upstream_tool" }),
        expect.objectContaining({ name: "list_pr_checks" })
      ])
    });
  });

  it("fails on upstream custom tool name collisions", async () => {
    await expect(handleRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      new Headers(),
      new MockUpstream({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "list_pr_checks", description: "collision", inputSchema: {} }] }
      })
    )).rejects.toThrow("Custom tool name collides with upstream tool: list_pr_checks");
  });

  it("passes the github token to custom tool handlers", async () => {
    // tools/call for a custom tool never touches upstream; this also exercises
    // the githubToken threading without making a real GitHub request.
    const result = await handleRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bulk_file_read", arguments: { files: [] } } },
      new Headers(),
      new MockUpstream({ jsonrpc: "2.0", id: 1, result: {} }),
      "gh-token"
    );

    expect(result.result).toMatchObject({ structuredContent: [] });
  });
});

describe("upstream SSE parsing", () => {
  it("parses a single-message SSE response into a JSON-RPC result", async () => {
    mockFetch([
      {
        body: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"upstream_tool"}]}}\n\n',
        headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" }
      }
    ]);

    const upstream = new UpstreamClient("http://upstream.invalid");
    const response = await upstream.forward({ jsonrpc: "2.0", id: 1, method: "tools/list" }, new Headers());

    expect(response.result).toMatchObject({ tools: [{ name: "upstream_tool" }] });
    expect(response._responseHeaders).toMatchObject({ "mcp-session-id": "sess-1" });
  });

  it("surfaces an upstream non-2xx body as a JSON-RPC error", async () => {
    mockFetch([{ status: 401, body: "Unauthorized", headers: { "content-type": "text/plain" } }]);

    const upstream = new UpstreamClient("http://upstream.invalid");
    const response = await upstream.forward({ jsonrpc: "2.0", id: 1, method: "tools/list" }, new Headers());

    expect(response.error?.code).toBe(-32003);
    expect(response.error?.message).toContain("HTTP 401");
  });
});

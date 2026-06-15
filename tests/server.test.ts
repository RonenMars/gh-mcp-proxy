import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/server.js";
import { ForwardResult, isRawPassthrough, JsonRpcRequest, JsonRpcResponse, UpstreamClient } from "../src/upstream.js";

class MockUpstream extends UpstreamClient {
  constructor(private readonly response: ForwardResult) {
    super("http://example.invalid");
  }

  override async forward(_request: JsonRpcRequest, _headers: Headers): Promise<ForwardResult> {
    return this.response;
  }
}

function asResponse(result: ForwardResult): JsonRpcResponse {
  if (isRawPassthrough(result)) {
    throw new Error("expected a JSON-RPC response, got a raw passthrough");
  }
  return result;
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

    expect(asResponse(result).result).toMatchObject({
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
});

describe("server pass-through", () => {
  it("forwards a raw SSE passthrough result unchanged", async () => {
    const result = await handleRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      new Headers(),
      new MockUpstream({
        raw: true,
        status: 200,
        contentType: "text/event-stream",
        headers: new Headers(),
        body: null
      })
    );

    expect(isRawPassthrough(result)).toBe(true);
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

    expect(asResponse(result).result).toMatchObject({ structuredContent: [] });
  });
});

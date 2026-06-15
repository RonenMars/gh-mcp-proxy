export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

// forward() returns either a parsed JSON-RPC response (the common case) or a
// raw passthrough when upstream replies with a non-JSON body — most importantly
// a Streamable HTTP SSE stream (`text/event-stream`), which must reach the
// client untouched rather than being JSON.parse-d into an error.
export type RawPassthrough = {
  raw: true;
  status: number;
  contentType: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

export type ForwardResult = JsonRpcResponse | RawPassthrough;

export function isRawPassthrough(result: ForwardResult): result is RawPassthrough {
  return (result as RawPassthrough).raw === true;
}

const SESSION_HEADERS = [
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "x-request-id"
];

// Upstream response headers worth surfacing back to the client on a raw
// passthrough (session continuity for Streamable HTTP).
const PASSTHROUGH_RESPONSE_HEADERS = [
  "mcp-session-id",
  "mcp-protocol-version",
  "x-request-id"
];

export function jsonRpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data }
  };
}

export class UpstreamClient {
  constructor(
    private readonly url: string,
    private readonly authToken?: string
  ) {}

  async forward(
    request: JsonRpcRequest,
    incomingHeaders: Headers
  ): Promise<ForwardResult> {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    });

    for (const name of SESSION_HEADERS) {
      const value = incomingHeaders.get(name);
      if (value) {
        headers.set(name, value);
      }
    }

    if (this.authToken) {
      headers.set("authorization", `Bearer ${this.authToken}`);
    }

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(request)
      });
    } catch (error) {
      return jsonRpcError(
        request.id,
        -32002,
        `Upstream MCP server unreachable at ${this.url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const contentType = response.headers.get("content-type") ?? "";

    // Streamable HTTP / SSE responses (and any other non-JSON body) are passed
    // straight through to the client, preserving status and session headers.
    if (!contentType.includes("application/json")) {
      const passthroughHeaders = new Headers();
      for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value) {
          passthroughHeaders.set(name, value);
        }
      }
      return {
        raw: true,
        status: response.status,
        contentType: contentType || "application/octet-stream",
        headers: passthroughHeaders,
        body: response.body
      };
    }

    const text = await response.text();
    if (!response.ok) {
      return jsonRpcError(
        request.id,
        -32003,
        `Upstream MCP server returned HTTP ${response.status}: ${text || response.statusText}`
      );
    }

    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      return jsonRpcError(
        request.id,
        -32004,
        "Upstream MCP server returned invalid JSON",
        text
      );
    }
  }
}

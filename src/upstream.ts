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
  // Upstream session/continuity headers to echo back to the client (set by the
  // proxy, not part of the JSON-RPC wire payload — stripped before serializing).
  _responseHeaders?: Record<string, string>;
};

const SESSION_HEADERS = [
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "x-request-id"
];

// Upstream response headers worth echoing back to the client for session
// continuity under Streamable HTTP.
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
  ): Promise<JsonRpcResponse> {
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
    const text = await response.text();

    if (!response.ok) {
      return jsonRpcError(
        request.id,
        -32003,
        `Upstream MCP server returned HTTP ${response.status}: ${text || response.statusText}`
      );
    }

    // The official github-mcp-server in HTTP mode answers every request as a
    // single-message SSE frame (`text/event-stream` with one `data:` line
    // carrying the JSON-RPC payload). Parse the payload out so the proxy can
    // merge tools / route, rather than passing the stream through opaquely.
    const payload = contentType.includes("text/event-stream")
      ? parseSseMessage(text)
      : text;

    if (payload === undefined) {
      return jsonRpcError(
        request.id,
        -32004,
        "Upstream SSE response contained no data message",
        text
      );
    }

    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(payload) as JsonRpcResponse;
    } catch {
      return jsonRpcError(
        request.id,
        -32004,
        "Upstream MCP server returned invalid JSON",
        text
      );
    }

    const responseHeaders = collectResponseHeaders(response.headers);
    if (responseHeaders) {
      parsed._responseHeaders = responseHeaders;
    }
    return parsed;
  }
}

// Extract the JSON payload from a single-message SSE response. Concatenates all
// `data:` lines of the last event per the SSE spec. Returns undefined if there
// is no data line.
function parseSseMessage(text: string): string | undefined {
  const dataLines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length > 0 ? dataLines.join("\n") : undefined;
}

function collectResponseHeaders(headers: Headers): Record<string, string> | undefined {
  const collected: Record<string, string> = {};
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value) {
      collected[name] = value;
    }
  }
  return Object.keys(collected).length > 0 ? collected : undefined;
}

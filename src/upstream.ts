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
  // Upstream HTTP status to relay verbatim (set by the proxy, stripped before
  // serializing). Lets an upstream 401 reach the client as a real 401 carrying
  // its WWW-Authenticate challenge, which is what starts the OAuth flow.
  _httpStatus?: number;
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
  "x-request-id",
  "www-authenticate"
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
    incomingHeaders: Headers,
    auth?: string | null
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

    // `auth` undefined -> act as the proxy itself (static UPSTREAM_AUTH_TOKEN).
    // `auth` a string   -> act as the caller, forwarding their header verbatim.
    // `auth` null       -> send none, so upstream issues its 401 challenge.
    if (auth === undefined) {
      if (this.authToken) {
        headers.set("authorization", `Bearer ${this.authToken}`);
      }
    } else if (auth !== null) {
      headers.set("authorization", auth);
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
      const failure = jsonRpcError(
        request.id,
        -32003,
        `Upstream MCP server returned HTTP ${response.status}: ${text || response.statusText}`
      );
      // Relay auth challenges with their real status and WWW-Authenticate header:
      // that pair is what tells an MCP client to begin the OAuth flow. Collapsing
      // it into a 200 JSON-RPC error leaves the client nothing to act on.
      if (response.status === 401 || response.status === 403) {
        failure._httpStatus = response.status;
        failure._responseHeaders = collectResponseHeaders(response.headers);
      }
      return failure;
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

  // Forward a non-JSON-RPC request (OAuth discovery GETs, the optional GET SSE
  // stream, session-teardown DELETEs) to upstream untouched. The official server
  // implements the whole MCP auth handshake itself, so the proxy only has to stay
  // out of its way.
  async proxyRaw(
    method: string,
    path: string,
    incomingHeaders: Headers
  ): Promise<Response> {
    const headers = new Headers();
    for (const name of [...SESSION_HEADERS, "authorization", "accept"]) {
      const value = incomingHeaders.get(name);
      if (value) {
        headers.set(name, value);
      }
    }
    return fetch(new URL(path, this.url), { method, headers, redirect: "manual" });
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

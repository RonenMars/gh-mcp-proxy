import http from "node:http";
import { bulkFileReadTool } from "./tools/bulk_file_read.js";
import { createIssueWithLabelsAndAssigneesTool } from "./tools/create_issue_with_labels_and_assignees.js";
import { getCommitDiffTool } from "./tools/get_commit_diff.js";
import { getWorkflowRunStatusTool } from "./tools/get_workflow_run_status.js";
import { listPrChecksTool } from "./tools/list_pr_checks.js";
import {
  JsonRpcRequest,
  JsonRpcResponse,
  jsonRpcError,
  UpstreamClient
} from "./upstream.js";

type Tool = {
  name: string;
  description: string;
  inputSchema: unknown;
  handler(args: unknown, token?: string): Promise<unknown>;
};

const customTools = [
  listPrChecksTool,
  bulkFileReadTool,
  getCommitDiffTool,
  createIssueWithLabelsAndAssigneesTool,
  getWorkflowRunStatusTool
] satisfies Tool[];

const customToolNames = new Set(customTools.map((tool) => tool.name));

type ServerOptions = {
  upstreamUrl?: string;
  proxyAuthToken?: string;
  upstreamAuthToken?: string;
  githubToken?: string;
};

export function createServer(options: ServerOptions = {}) {
  const upstream = new UpstreamClient(
    options.upstreamUrl ?? process.env.UPSTREAM_URL ?? "http://github-mcp:8082",
    options.upstreamAuthToken ?? process.env.UPSTREAM_AUTH_TOKEN
  );
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
  const proxyAuthToken = options.proxyAuthToken ?? process.env.PROXY_AUTH_TOKEN;

  return http.createServer(async (req, res) => {
    // Everything that is not a JSON-RPC POST — OAuth discovery under
    // `/.well-known/`, the optional GET SSE stream, session-teardown DELETEs —
    // belongs to upstream, which already implements the full MCP auth handshake.
    // Answering these with 405 here killed discovery before it began.
    if (req.method !== "POST") {
      await relayRaw(req, res, upstream);
      return;
    }

    // Two kinds of caller are accepted. One presenting PROXY_AUTH_TOKEN acts as
    // the proxy itself: upstream sees UPSTREAM_AUTH_TOKEN and custom tools use the
    // server-side GITHUB_TOKEN. Any other caller acts as themselves — their
    // Authorization header is forwarded verbatim and upstream's GitHub OAuth is
    // the authority on whether it is valid, so the proxy never has to validate a
    // token it did not issue.
    const authHeader = req.headers.authorization;
    const isStaticCaller = Boolean(proxyAuthToken) && authHeader === `Bearer ${proxyAuthToken}`;
    const upstreamAuth = isStaticCaller ? undefined : (authHeader ?? null);
    const toolToken = isStaticCaller ? githubToken : bearerToken(authHeader);

    const body = await readBody(req);
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(body) as JsonRpcRequest;
    } catch {
      writeJson(res, jsonRpcError(null, -32700, "Invalid JSON"));
      return;
    }

    // JSON-RPC notifications carry no id and must not receive a response body.
    // Forward to upstream (fire-and-forget) and acknowledge with 202.
    const isNotification = request.id === undefined;

    try {
      const result = await handleRequest(
        request,
        incomingHeaders(req),
        upstream,
        toolToken,
        upstreamAuth
      );
      if (isNotification) {
        res.writeHead(202);
        res.end();
        return;
      }
      writeJson(res, result);
    } catch (error) {
      if (isNotification) {
        res.writeHead(202);
        res.end();
        return;
      }
      writeJson(res, jsonRpcError(
        request.id,
        -32000,
        error instanceof Error ? error.message : String(error)
      ));
    }
  });
}

export async function startServer(options: ServerOptions & { port?: number } = {}) {
  const upstream = new UpstreamClient(
    options.upstreamUrl ?? process.env.UPSTREAM_URL ?? "http://github-mcp:8082",
    options.upstreamAuthToken ?? process.env.UPSTREAM_AUTH_TOKEN
  );
  const listResult = await upstream.forward({
    jsonrpc: "2.0",
    id: "startup-tools-list",
    method: "tools/list"
  }, new Headers());
  if (listResult.error) {
    throw new Error(`Failed to verify upstream tools during startup: ${listResult.error.message}`);
  }
  failOnToolCollision(getTools(listResult.result));

  const server = createServer(options);
  const port = options.port ?? Number(process.env.PORT ?? 8082);
  await new Promise<void>((resolve) => server.listen(port, () => resolve()));
  return server;
}

export async function handleRequest(
  request: JsonRpcRequest,
  headers: Headers,
  upstream: UpstreamClient,
  githubToken?: string,
  upstreamAuth?: string | null
): Promise<JsonRpcResponse> {
  if (request.method === "tools/list") {
    const upstreamResponse = await upstream.forward(request, headers, upstreamAuth);
    if (upstreamResponse.error) {
      return upstreamResponse;
    }
    const upstreamTools = getTools(upstreamResponse.result);
    failOnToolCollision(upstreamTools);
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        ...(upstreamResponse.result as object),
        tools: [
          ...upstreamTools,
          ...customTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
        ]
      },
      _responseHeaders: upstreamResponse._responseHeaders
    };
  }

  if (request.method === "tools/call") {
    const params = request.params as { name?: string; arguments?: unknown } | undefined;
    const tool = customTools.find((candidate) => candidate.name === params?.name);
    // With no token the call is anonymous, so serving it here would spend the
    // proxy's own GitHub credentials on an unauthenticated caller. Fall through to
    // upstream instead and let it answer with the 401 challenge.
    if (tool && githubToken) {
      const result = await tool.handler(params?.arguments ?? {}, githubToken);
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result
        }
      };
    }
  }

  // `initialize`, `resources/*`, `prompts/*`, notifications, and every other
  // upstream tool are forwarded unchanged. The proxy only adds tools (merged in
  // tools/list above), so upstream's advertised capabilities pass through as-is.
  return upstream.forward(request, headers, upstreamAuth);
}

function getTools(result: unknown): Array<{ name: string }> {
  if (!result || typeof result !== "object" || !("tools" in result)) {
    return [];
  }
  const tools = (result as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools as Array<{ name: string }> : [];
}

function failOnToolCollision(upstreamTools: Array<{ name: string }>) {
  const collision = upstreamTools.find((tool) => customToolNames.has(tool.name));
  if (collision) {
    throw new Error(`Custom tool name collides with upstream tool: ${collision.name}`);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, response: JsonRpcResponse) {
  const { _responseHeaders, _httpStatus, ...body } = response;
  res.writeHead(_httpStatus ?? 200, { "content-type": "application/json", ...(_responseHeaders ?? {}) });
  res.end(JSON.stringify(body));
}

function incomingHeaders(req: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    } else if (value) {
      headers.set(name, value);
    }
  }
  return headers;
}

// Response headers worth relaying from a raw (non-JSON-RPC) upstream reply.
const RAW_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "www-authenticate",
  "mcp-session-id",
  "mcp-protocol-version",
  "location"
];

async function relayRaw(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: UpstreamClient
) {
  let upstreamResponse: Response;
  try {
    upstreamResponse = await upstream.proxyRaw(
      req.method ?? "GET",
      req.url ?? "/",
      incomingHeaders(req)
    );
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify(jsonRpcError(
      null,
      -32002,
      error instanceof Error ? error.message : String(error)
    )));
    return;
  }

  const headers: Record<string, string> = {};
  for (const name of RAW_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  res.writeHead(upstreamResponse.status, headers);

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  // Streamed, not buffered: a GET SSE stream stays open indefinitely, so waiting
  // for EOF would hang the client instead of relaying events as they arrive.
  const reader = upstreamResponse.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!res.write(Buffer.from(value))) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
  }
  res.end();
}

function bearerToken(header?: string): string | undefined {
  return header?.match(/^Bearer\s+(.+)$/i)?.[1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer()
    .then(() => console.log(`gh-mcp-proxy listening on ${process.env.PORT ?? 8082}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

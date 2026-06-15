# gh-mcp-proxy

A TypeScript MCP proxy that fronts the official GitHub MCP server
(`ghcr.io/github/github-mcp-server`) and adds 5 high-value custom tools backed by
the GitHub REST API.

The official server is a prebuilt binary and can't be extended directly. This
proxy sits in front of it at the same public URL, passes the entire upstream MCP
surface through unchanged, merges in the custom tools, and enforces a bearer-token
auth boundary before any MCP request is handled.

## Architecture

```
claude.ai / Claude Code
        ↓ HTTPS
https://gh-mcp.rbv1000.win        ← Cloudflare Tunnel
        ↓
   [gh-mcp-proxy :8082]           ← this project
      ↙           ↘
custom tools    pass-through → [github-mcp :8082]  ← upstream, internal only
(GitHub REST)                   ghcr.io/github/github-mcp-server http
```

Both containers run as a single Docker Compose stack.

## Custom tools

| Tool | Purpose |
|------|---------|
| `list_pr_checks` | Check runs + legacy commit statuses for a SHA/branch |
| `bulk_file_read` | Read multiple repo files in one call, per-file errors |
| `get_commit_diff` | Commit message + raw unified diff |
| `create_issue_with_labels_and_assignees` | Atomic issue creation with labels/assignees/milestone |
| `get_workflow_run_status` | Per-job pass/fail summary for a commit SHA |

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest (in-process upstream mock)
npm run dev        # tsx src/server.ts
```

The default test suite uses an in-process mock upstream and never touches Docker
or GitHub. A real Docker Compose smoke test lives in `tests/compose.test.ts` and
is opt-in:

```bash
RUN_COMPOSE_TEST=1 npm test   # needs Docker running + a real GITHUB_PERSONAL_ACCESS_TOKEN
```

## Configuration

Copy `.env.example` → `.env` and fill in:

| Variable | Used by | Purpose |
|----------|---------|---------|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | upstream `github-mcp` | Token for the official server |
| `GITHUB_TOKEN` | proxy custom tools | Token for the proxy's GitHub REST calls |
| `PROXY_AUTH_TOKEN` | proxy | Bearer token required from MCP clients |
| `UPSTREAM_AUTH_TOKEN` | proxy | Bearer token injected when forwarding upstream — **required**: the official server returns HTTP 401 without it. Set it to the same PAT. |
| `UPSTREAM_URL` | proxy | Upstream MCP server URL (default `http://github-mcp:8082`) |

> **SSE note:** the official `github-mcp-server` in HTTP mode answers every
> request as a single-message Server-Sent-Events frame (`text/event-stream` with
> one `data:` line). The proxy parses that frame back into a JSON-RPC response so
> it can merge the custom tools and route calls; the upstream `Mcp-Session-Id` is
> echoed to the client for session continuity.

## Deployment

```bash
cp .env.example .env   # fill in tokens
docker compose up -d   # starts upstream (HTTP mode) + proxy on :8082
```

Update the upstream image with `docker compose pull && docker compose up -d`.

# Setup guide

How to run `gh-mcp-proxy` on macOS, Windows, and Linux.

The proxy ships as a two-container Docker Compose stack (the official
`github-mcp-server` upstream + this proxy), so the steps are nearly identical on
every OS — only how you install Docker and edit files differs. There's also a
[no-Docker local dev path](#local-development-no-docker) at the bottom.

- [Prerequisites](#prerequisites)
- [Required tokens](#required-tokens)
- [macOS](#macos)
- [Windows](#windows)
- [Linux](#linux)
- [Verify it works](#verify-it-works)
- [Updating](#updating)
- [Local development (no Docker)](#local-development-no-docker)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Docker Engine + Docker Compose v2** (`docker compose`, not the old
  `docker-compose`). Compose v2 ships with Docker Desktop and recent Docker
  Engine.
- **Git**, to clone the repo.
- A **GitHub Personal Access Token (PAT)** with the scopes you want the GitHub
  tools to use (typically `repo`, `read:org`, `workflow`).

Check your tooling:

```bash
docker --version
docker compose version    # must be v2.x
git --version
```

---

## Required tokens

Every deployment needs a `.env` file (copied from `.env.example`). All four token
vars must be set:

| Variable | Set to | Why |
|----------|--------|-----|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | your GitHub PAT | the official upstream `github-mcp` server uses it |
| `GITHUB_TOKEN` | your GitHub PAT | the proxy's own REST-backed custom tools use it |
| `PROXY_AUTH_TOKEN` | a distinct random secret | bearer token MCP clients must send to the proxy |
| `UPSTREAM_AUTH_TOKEN` | **your GitHub PAT** | **required** — see warning below |
| `UPSTREAM_URL` | leave as `http://github-mcp:8082` | internal compose address of the upstream |

> ### ⚠️ `UPSTREAM_AUTH_TOKEN` is required — the proxy won't boot without it
>
> The official `github-mcp-server` in HTTP mode rejects any request that arrives
> with **no `Authorization` header** (`HTTP 401`). The proxy verifies the upstream
> tool list at startup; with no token that check 401s and the proxy container
> **exits 1** (the upstream container stays up, so it looks half-broken). Set
> `UPSTREAM_AUTH_TOKEN` to the same value as `GITHUB_PERSONAL_ACCESS_TOKEN`.

Generate a strong `PROXY_AUTH_TOKEN`:

```bash
# macOS / Linux
openssl rand -hex 32
```
```powershell
# Windows PowerShell
[Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

`.env` is gitignored — it never gets committed.

---

## macOS

```bash
# 1. Install Docker Desktop (if not already)
brew install --cask docker
open -a Docker          # start it; wait for the whale icon to settle

# 2. Clone
git clone git@github.com:RonenMars/gh-mcp-proxy.git ~/dev/gh-mcp-proxy
cd ~/dev/gh-mcp-proxy

# 3. Configure
cp .env.example .env
$EDITOR .env            # fill in all tokens (see "Required tokens")

# 4. Run
docker compose up -d --build
```

Then [verify](#verify-it-works).

---

## Windows

Use PowerShell. (This is the production deployment box behind the Cloudflare
tunnel.)

```powershell
# 1. Install Docker Desktop (if not already)
winget install Docker.DockerDesktop
# launch Docker Desktop and wait until the engine is running

# 2. Clone (canonical path for the production box)
git clone git@github.com:RonenMars/gh-mcp-proxy.git C:\docker\gh-mcp-proxy
cd C:\docker\gh-mcp-proxy

# 3. Configure
Copy-Item .env.example .env
notepad .env            # fill in all tokens (see "Required tokens")

# 4. If an OLD standalone github-mcp container is running, stop it first
#    (so it doesn't hold port 8082). Skip if it's already managed by this stack.
docker ps               # find the old container name
docker rm -f <old-container-name>

# 5. Run
docker compose up -d --build
```

> On the production PC the PAT comes from the 1Password secrets pipeline — see the
> dotfiles doc `docs/windows-config/gh-mcp-proxy-deploy.md`. The Cloudflare tunnel
> already points `gh-mcp.rbv1000.win` → port `8082`; no tunnel change is needed.

Then [verify](#verify-it-works).

---

## Linux

```bash
# 1. Install Docker Engine + Compose plugin (Debian/Ubuntu shown)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # then log out/in so `docker` works without sudo

# 2. Clone
git clone git@github.com:RonenMars/gh-mcp-proxy.git ~/gh-mcp-proxy
cd ~/gh-mcp-proxy

# 3. Configure
cp .env.example .env
"${EDITOR:-nano}" .env            # fill in all tokens (see "Required tokens")

# 4. Run
docker compose up -d --build
```

Then [verify](#verify-it-works).

---

## Verify it works

After `docker compose up -d`, confirm the **proxy** container actually booted —
not just that it was created:

```bash
docker compose ps
# gh-mcp-proxy must show "Up", NOT "Exited (1)".
# If it exited, see Troubleshooting.

docker compose logs gh-mcp-proxy
# Healthy: "gh-mcp-proxy listening on 8082"
```

Hit the proxy and confirm tools are merged (replace `<PROXY_AUTH_TOKEN>`):

```bash
curl -s -X POST http://127.0.0.1:8082 \
  -H "authorization: Bearer <PROXY_AUTH_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should get back a JSON-RPC result whose `result.tools` array contains the 5
custom tools (`list_pr_checks`, `bulk_file_read`, …) alongside the upstream tools.

A request with **no** `Authorization` header should return an `Unauthorized`
error — that confirms the auth boundary is active.

You can also run the automated end-to-end smoke test (brings the stack up itself):

```bash
RUN_COMPOSE_TEST=1 GITHUB_PERSONAL_ACCESS_TOKEN=<pat> PROXY_AUTH_TOKEN=<secret> npm test -- tests/compose.test.ts
```

---

## Updating

```bash
git pull
docker compose pull          # pull the latest upstream github-mcp-server image
docker compose up -d --build # rebuild the proxy and restart both
```

---

## Local development (no Docker)

For iterating on the proxy code without the upstream container, run it directly
with Node (the test suite uses an in-process mock upstream, so no Docker or live
GitHub is needed for tests):

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest, in-process mock upstream
npm run dev        # tsx src/server.ts (needs UPSTREAM_URL + tokens in env to talk to a real upstream)
```

Requires **Node.js ≥ 20**.

---

## Troubleshooting

**`gh-mcp-proxy` container shows `Exited (1)`**, logs say
`Failed to verify upstream tools during startup: ... HTTP 401 ...`
→ `UPSTREAM_AUTH_TOKEN` is missing or wrong. Set it to your PAT and
`docker compose up -d` again. (This is the #1 setup mistake.)

**`Upstream MCP server unreachable`**
→ The upstream container isn't up yet or `UPSTREAM_URL` is wrong. Check
`docker compose ps` and `docker compose logs github-mcp`. The default
`http://github-mcp:8082` only resolves *inside* the compose network — don't change
it unless you're running the proxy outside Compose.

**Port 8082 already in use**
→ An old standalone `github-mcp` container (or another service) holds the port.
Stop it (`docker rm -f <name>`) before `docker compose up`.

**`docker compose` not found, but `docker-compose` is**
→ You have the legacy v1 binary. Install the Compose v2 plugin (bundled with
Docker Desktop; on Linux `sudo apt install docker-compose-plugin`).

**Clients get `Unauthorized` unexpectedly**
→ The client must send `Authorization: Bearer <PROXY_AUTH_TOKEN>`. If you front the
proxy with Cloudflare Access instead, you can leave `PROXY_AUTH_TOKEN` unset and
let Access be the gate — but don't expose the proxy publicly with neither.

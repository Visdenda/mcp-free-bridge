# @visdenda/mcp-free-bridge

[![Visdenda Free MCP on Glama](https://glama.ai/mcp/connectors/com.visdenda/free/badges/score.svg)](https://glama.ai/mcp/connectors/com.visdenda/free)

Zero-dependency stdio bridge for the anonymous Visdenda MCP server. It lets MCP clients that only
speak stdio use the hosted endpoint at `https://visdenda.com/v1/mcp/free`.

Current package version: `0.7.0`. The bridge remains a transparent proxy: tool names, schemas and
limits are served by the endpoint.

Since 0.7.0 the hosted server's default `tools/list` omits `outputSchema` (same policy as the
account server; model-facing tool selection only needs name/title/description/inputSchema). Strict
clients that validate structured output can send `_meta: { "dev.visdenda/outputSchemas": true }`
and get the full definitions back.

Since 0.6.0 the free server serves 10 tools, including `visdenda_get_agent_skill`: it returns the
`ai-crawler-readiness` SKILL.md (name, version, description, auth, compatibility, canonical URL,
markdown and task references) without an API key, and the new `ai-crawler-readiness` prompt walks a
client from that skill through `visdenda_audit_site` and a before/after comparison.

Since 0.5.2 the free server also exposes the `ai-crawler-readiness` skill as the
`visdenda://skills/ai-crawler-readiness.md` resource; the bridge passes `resources/list` and
`resources/read` through unchanged.

Since 0.5.0 the hosted server also exposes ChatGPT-compatible `search` and `fetch` tools: `search`
returns citable ids and URLs from the public SEO knowledge base, and `fetch` reads one entry by id.

Since 0.3.0 the bridge also mirrors modern MCP request metadata (`MCP-Protocol-Version`, `Mcp-Method`,
`Mcp-Name`, base64-encoding unsafe names) derived from each JSON-RPC message, so clients speaking
the 2026-07-28 per-request protocol work through the stdio shim.

The package is a thin proxy, not a second implementation: it forwards newline-delimited JSON-RPC
from stdin to the remote Streamable HTTP endpoint and writes the response back to stdout. The
hosted endpoint remains the source of truth for tools, prompts, results, quotas, and protocol
behavior.

## Requirements

- Node.js 18 or newer (uses the built-in `fetch`).

## Run

Normally your MCP client spawns the bridge for you:

```bash
npx -y @visdenda/mcp-free-bridge
```

To run it directly from this package:

```bash
pnpm start
```

The process reads JSON-RPC messages from stdin and writes JSON-RPC responses to stdout, one JSON
object per line. Diagnostics go to stderr only.

## Claude Desktop

Add a server to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`, Windows:
`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "visdenda-free": {
      "command": "npx",
      "args": ["-y", "@visdenda/mcp-free-bridge"]
    }
  }
}
```

On Windows, Claude Desktop may require wrapping the command:

```json
{
  "mcpServers": {
    "visdenda-free": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@visdenda/mcp-free-bridge"]
    }
  }
}
```

Restart Claude Desktop after editing the file.

## Cursor

Use the same `mcpServers` shape in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "visdenda-free": {
      "command": "npx",
      "args": ["-y", "@visdenda/mcp-free-bridge"]
    }
  }
}
```

## VS Code

VS Code uses a `servers` object and an explicit stdio type in `.vscode/mcp.json`:

```json
{
  "servers": {
    "visdenda-free": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@visdenda/mcp-free-bridge"]
    }
  }
}
```

## Configuration

| Variable                  | Default                            | Purpose                                                          |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `VISDENDA_MCP_URL`        | `https://visdenda.com/v1/mcp/free` | Override the remote endpoint, for local development or testing.  |
| `VISDENDA_MCP_TIMEOUT_MS` | `60000`                            | Per-request timeout; a stalled request cannot wedge the process. |

Example for a local backend:

```json
{
  "mcpServers": {
    "visdenda-free": {
      "command": "npx",
      "args": ["-y", "@visdenda/mcp-free-bridge"],
      "env": { "VISDENDA_MCP_URL": "http://127.0.0.1:3102/v1/mcp/free" }
    }
  }
}
```

## Behavior

- Requests (messages with an `id`) are POSTed to the endpoint with
  `content-type: application/json` and `accept: application/json, text/event-stream`.
- JSON responses are written as one line. Server-Sent Events responses are reduced to the last
  `data:` JSON event.
- Notifications (messages without an `id`) are forwarded, and no response is written.
- Error responses from the endpoint are passed through unchanged, so quota errors keep their
  JSON-RPC code, `data.code` and `retryAfterSeconds`.
- Network failures, timeouts and non-JSON error responses become a JSON-RPC error with the same
  `id` and code `-32000`; the process keeps running.
- Each message is sent in order, one at a time, so a slow `tools/call` delays later messages rather
  than interleaving them.
- Nothing except JSON-RPC responses is written to stdout.

## Limits

The remote endpoint is anonymous: no API key or account is required. It is rate-limited per client
IP, currently 100 database-backed calls and 5 network calls per UTC day, plus 3 page scans and 30
requests a minute. Calls that exceed the limit return HTTP 429 with JSON-RPC `-32003` and
`Retry-After`. See <https://visdenda.com/mcp/free> for the current limits and tool documentation.

## Publishing (maintainers)

`server.json` is the MCP Registry manifest for the remote-only free server; its `version` must
match `package.json` and `publish.mjs --check` enforces that along with the public repository URL.

npm publishes from the public mirror repository (`visdenda/mcp-free-bridge`), not from the private
monorepo: only a public repository can produce npm provenance. A version bump merged to `main` is
mirrored automatically, tagged, and published by the mirror's workflow.

```bash
pnpm --filter @visdenda/mcp-free-bridge check:package   # local pre-flight, no network
```

Registry publishing stays manual (run it where `server.json` lives: this directory in the source
monorepo, the repository root in the public mirror):

```bash
mcp-publisher login dns --domain visdenda.com   # one-time namespace verification
mcp-publisher publish                            # reads ./server.json
```

The full launch order (org and mirror setup, npm → registry → directories, copy blocks and the
pre-publish checklist) lives in the repository at
`docs/operations/public-distribution.md` and
`docs/seo/link-building/mcp-free-launch/README.md`.

## License

MIT

## Source

This repository is the public source mirror of `@visdenda/mcp-free-bridge`. Development happens in
a private monorepo; fixes are ported here before a release, and npm publishes from this repository
with provenance. The hosted endpoint itself is documented at <https://visdenda.com/mcp/free>.
Issues are welcome here.

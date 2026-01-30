<p align="center">
  <img src="assets/icon.png" alt="Waypoint" width="128" height="128" />
</p>

<h1 align="center">Waypoint</h1>

<p align="center">
  <strong>Local AI Gateway</strong> — OpenAI-compatible proxy with intelligent routing, failover, and a built-in playground UI for agentic workflows.
</p>

<p align="center">
  <em>Sometimes a good LLM endpoint works behind a bad SSL cert. Waypoint bridges the gap—connect to any backend, handle SSL issues gracefully, and unify multiple endpoints behind one secure local interface.</em>
</p>

---

## Screenshots

### Playground
<p align="center">
  <img src="assets/playground.png" alt="Playground with chat interface" width="800" />
</p>

### Agent Mode with Tool Calling
<p align="center">
  <img src="assets/agent-mode.png" alt="Agent mode with MCP tools" width="800" />
</p>

### Endpoint Proxy & Usage Guides
<p align="center">
  <img src="assets/endpoint-proxy.png" alt="Local proxy to remote LLM endpoints with usage examples" width="800" />
</p>

### Dashboard
<p align="center">
  <img src="assets/dashboard.png" alt="Real-time statistics dashboard" width="800" />
</p>

---

## Features

- **Reverse Proxy** — Route LLM, diffusion, audio, and embedding requests to multiple backends
- **Health-Based Failover** — Automatic retry with circuit breaker and latency-aware routing
- **Web UI** — Playground with chat history, image support, and real-time dashboard
- **Agent Mode** — MCP (Model Context Protocol) integration for tool-calling workflows
- **Statistics** — Request tracking with 7-day window and per-model/endpoint aggregation
- **Hot Reload** — Config changes apply without restart
- **Auth Ready** — Optional authentication (disabled by default)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Waypoint Gateway                          │
├─────────────────────────────────────────────────────────────────────┤
│  Routes:                                                            │
│    /v1/chat/completions    → LLM backends                          │
│    /v1/embeddings          → Embedding backends                     │
│    /v1/images/*            → Diffusion backends                     │
│    /v1/audio/*             → Audio backends (TTS/STT)               │
│    /v1/models              → Aggregated model list                  │
│    /v1/responses           → Responses API shim                     │
│                                                                     │
│  Admin:                                                             │
│    /admin/endpoints        → Endpoint CRUD                          │
│    /admin/health           → Health status                          │
│    /admin/stats            → Request statistics                     │
│    /admin/sessions         → Chat session storage                   │
│    /admin/mcp/*            → MCP server management                  │
│                                                                     │
│  UI:                                                                │
│    /ui                     → React playground & dashboard           │
├─────────────────────────────────────────────────────────────────────┤
│  Storage (~/.config/waypoint):                                      │
│    config.yaml       │ Endpoint configuration                       │
│    health.json       │ Health state cache                           │
│    stats/*.jsonl     │ Request logs (30-day rotation)               │
│    sessions/*.json   │ Chat session history                         │
│    images/           │ AIGC image cache (LRU, 1GB default)          │
│    mcp-servers.yaml  │ MCP server registry                          │
└─────────────────────────────────────────────────────────────────────┘
```

## Quickstart

```bash
# Install dependencies
npm install
cd ui && npm install && cd ..

# Build
npm run build:all

# Start server
npm run start
```

Open http://localhost:8000/ui for the web interface.

## Add an Endpoint

```bash
# Via CLI
waypoint add \
  --name local-llm \
  --url http://localhost:11434 \
  --priority 1 \
  --type llm \
  --model local-default=llama3

# Diffusion endpoint
waypoint add \
  --name local-sd \
  --url http://localhost:7860 \
  --priority 1 \
  --type diffusion \
  --model sd-xl=stable-diffusion-xl
```

## OpenAI-Compatible Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | Chat with streaming and tool calling |
| `POST /v1/embeddings` | Text embeddings for RAG |
| `GET /v1/models` | List available models |
| `POST /v1/images/generations` | Image generation |
| `POST /v1/images/edits` | Image editing |
| `POST /v1/audio/transcriptions` | Speech-to-text |
| `POST /v1/audio/speech` | Text-to-speech |
| `POST /v1/responses` | Responses API shim |

## Admin Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /admin/endpoints` | List all endpoints |
| `POST /admin/endpoints` | Add endpoint |
| `PATCH /admin/endpoints/:id` | Update endpoint |
| `DELETE /admin/endpoints/:id` | Remove endpoint |
| `GET /admin/health` | Health status by endpoint |
| `GET /admin/stats` | Aggregated statistics |
| `GET /admin/stats/latency` | Latency distribution |
| `GET /admin/stats/tokens` | Token usage over time |
| `GET/POST/DELETE /admin/sessions` | Chat session CRUD |
| `GET/POST/DELETE /admin/mcp/servers` | MCP server CRUD |
| `GET /admin/mcp/tools` | List discovered tools |
| `POST /admin/mcp/tools/execute` | Execute a tool |

## CLI Commands

```bash
# Agent commands (NEW!)
waypoint "Fix the bug in main.ts"     # Run agent with prompt
waypoint run "Add unit tests" --auto  # Explicit run with options
waypoint doctor                       # Verify agent configuration

# Endpoint management
waypoint ls                           # List endpoints
waypoint add --name --url --priority  # Add endpoint
waypoint rm <id|name>                 # Remove endpoint
waypoint edit                         # Edit config.yaml in $EDITOR
waypoint stat                         # Run health check
waypoint test <model>                 # Test a model
waypoint acct                         # Token usage by endpoint

# Service management
waypoint service start                # Start background service
waypoint service stop                 # Stop service
waypoint service restart              # Restart service
waypoint service status               # Check if running

# Logs & stats
waypoint logs                         # Show last 50 log lines
waypoint logs -f                      # Follow log output
waypoint stats                        # Show 7-day statistics
waypoint stats --window=24h           # Custom time window
waypoint stats --json                 # JSON output

# MCP server management
waypoint mcp add --name --url         # Add MCP server
waypoint mcp list                     # List MCP servers
waypoint mcp rm <id|name>             # Remove MCP server
waypoint mcp enable <id|name>         # Enable server
waypoint mcp disable <id|name>        # Disable server
```

## Agent Runtime

Waypoint includes a built-in agent runtime that executes AI-driven tasks using your configured LLM endpoints:

```bash
# Simple usage - just provide a prompt
waypoint "Refactor the authentication module to use JWT"

# With options
waypoint run "Add comprehensive error handling" \
  --model gpt-4 \
  --auto \
  --cwd ./src

# Check your agent setup
waypoint doctor
```

### Agent Isolation

All agent data is isolated from global installations:
- **Data directory**: `~/.config/waypoint/codex` (never `~/.codex`)
- **API endpoint**: Your Waypoint proxy (never `api.openai.com`)
- **Runtime verification**: `waypoint doctor` validates isolation invariants

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WAYPOINT_CODEX_HOME` | `~/.config/waypoint/codex` | Agent data directory |
| `WAYPOINT_BASE_URL` | `http://localhost:8000/v1` | API endpoint |
| `WAYPOINT_API_KEY` | `local-dev` | Authentication key |
| `WAYPOINT_DEFAULT_MODEL` | (none) | Default model for agent |

## Web UI

Access the playground at `http://localhost:8000/ui`:

- **Playground** — Chat interface with session history, image upload (VL models), and agent mode
- **Dashboard** — Real-time stats with latency charts, token usage, endpoint health, and **usage guides** with copy-paste code snippets (cURL, Python, Node.js)
- **Settings** — Endpoint configuration (coming soon)

### Endpoint Usage Guides

Each endpoint in the Dashboard includes an expandable "Usage Guide" dropdown showing:
- **cURL** — Command-line examples for quick testing
- **Python** — OpenAI SDK code with your proxy URL
- **Node.js** — TypeScript/JavaScript examples

All code snippets use `localhost:PORT` (your proxy) instead of the upstream endpoint, so you can copy-paste and run immediately.

### Agent Mode

Toggle "Agent Mode" in the playground to enable tool calling:

1. Add MCP servers via UI or CLI
2. Connect to discover available tools
3. Select which tools to enable
4. Chat normally — the agent will use tools when appropriate

The agentic loop supports up to 10 tool iterations per message.

## Configuration

### config.yaml

```yaml
endpoints:
  - name: openai
    baseUrl: https://api.openai.com
    apiKey: sk-...
    priority: 1
    type: llm
    models:
      - publicName: gpt-4
        upstreamModel: gpt-4-turbo
  
  - name: local-sd
    baseUrl: http://localhost:7860
    priority: 1
    type: diffusion
    models:
      - publicName: sd-xl
        upstreamModel: stable-diffusion-xl-base-1.0

# Enable authentication (default: false)
authEnabled: false
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | Server port |
| `ADMIN_TOKEN` | — | Bearer token for admin endpoints |
| `WAYPOINT_DIR` | `~/.config/waypoint` | Storage directory |
| `WAYPOINT_CONFIG` | `{dir}/config.yaml` | Config file path |

## Storage

All data is stored in `~/.config/waypoint` (or `$WAYPOINT_DIR`):

| File/Directory | Purpose |
|----------------|---------|
| `config.yaml` | Endpoint configuration |
| `health.json` | Cached health state |
| `stats/` | JSONL stats files (30-day retention) |
| `sessions/` | Chat session JSON files |
| `images/` | AIGC image cache (1GB LRU) |
| `mcp-servers.yaml` | MCP server registry |
| `waypoint.pid` | Service PID file |
| `waypoint.log` | Service log file |

## Development

```bash
# Run in development mode
npm run dev

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint
```

## Authentication

Authentication is disabled by default. To enable:

1. Set `authEnabled: true` in `config.yaml`
2. Restart (or wait for hot-reload)
3. Include `Authorization: Bearer <token>` header

The auth middleware protects `/admin/*` and `/ui/*` routes.

## Manual Testing

```bash
# Test chat completions
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "local-default", "messages": [{"role": "user", "content": "Hello"}]}'

# Test image generation
curl http://localhost:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model": "sd-xl", "prompt": "A sunset over mountains"}'

# Run manual test script
BASE_URL=http://localhost:8000 MODEL=local-default npm run manual-test
```

## License

MIT

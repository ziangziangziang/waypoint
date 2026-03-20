# Waypoint v0.6.0

## What's New

### 🛠️ Built-in MCP Service
Waypoint now includes a first-party MCP server at `POST /mcp` (localhost-only) with two powerful tools:

- **`generate_image`** - Generate images directly from chat with file-first output policy. Images are always written to your workspace with relative paths returned.
- **`understand_image`** - Analyze images with vision models, preserving original geometry for coordinate-sensitive tasks.

### 🤖 Agent Mode
Toggle Agent Mode in the Playground to enable tool-calling workflows. Select tools from the picker, and the agent will automatically use them during conversations (up to 10 iterations per message).

### 📊 Token Flow Sankey
New visualization in Peek shows where tokens went - input vs output, attributed by model. Debug your token usage with visual clarity.

## Core Features

- **OpenAI-Compatible Proxy** - `localhost:8000/v1` routes to multiple backends
- **Health-Based Failover** - Automatic retry with circuit breaker
- **Provider-First Architecture** - `waypoint providers import -f .env`
- **Real-Time Dashboard** - Latency, tokens, errors, per-model stats
- **Peek Request Inspector** - Calendar browser + timeline + Sankey

## Breaking Changes

None. This is a feature release.

## Migration

No migration needed. Existing configs work as-is.

## Screenshots

### Agent Mode with MCP Tools
![MCP Image Generation](https://github.com/zziang/waypoint/blob/dev/assets/mcp-generate-image.png?raw=true)

### Image Understanding
![MCP Image Understanding](https://github.com/zziang/waypoint/blob/dev/assets/mcp-understand-image.png?raw=true)

### Token Flow Sankey
![Peek Token Flow](https://github.com/zziang/waypoint/blob/dev/assets/peek-token-flow.png?raw=true)

## Installation

```bash
git clone https://github.com/zziang/waypoint
cd waypoint
npm install
cd ui && npm install && cd ..
npm run build:all
npm run start
```

Visit `http://localhost:8000/ui`

## Links

- [Documentation](https://github.com/zziang/waypoint#readme)
- [MCP Service Guide](https://github.com/zziang/waypoint/blob/main/docs/mcp-service.md)
- [MCP Guidelines](https://github.com/zziang/waypoint/blob/main/docs/mcp-guidelines.md)

---

Built with ❤️ for the local AI community

# Changelog

All notable changes to Waypoint will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-01-29

### Added

- **Auto Model Selection** - Agent runtime automatically picks the best available LLM model when no `--model` flag is specified
  - Selects from healthy endpoints based on priority and latency
  - Uses `pickBestLlmModel()` from storage repositories
- **SSE Streaming for Responses API** - `/v1/responses` now supports proper Server-Sent Events streaming format compatible with Codex agent runtime
  - Events: `response.created`, `response.output_item.done`, `response.completed`
  - Content type uses `output_text` (Codex format) instead of `text`
  - Tool calls transformed to `function_call` output items
- **Tool Format Transformation** - Codex tool format automatically converted to OpenAI function calling format
  - Wraps `{type:"function", name, parameters}` → `{type:"function", function:{name, parameters}}`
  - Filters out `web_search` tools (not OpenAI compatible)
- **Message Content Transformation** - Fixes `input_text` → `text` content part types for OpenAI compatibility

### Fixed

- **Agent streaming compatibility** - Agent runtime now works correctly with Waypoint proxy (was failing with "stream closed before response.completed")
- **Models API Codex compatibility** - `/v1/models` now includes both `data` (OpenAI) and `models` (Codex) fields

---

## [Unreleased]

### Added

- **Agent Runtime** - Waypoint now includes an integrated agent runtime
  - `waypoint run "<prompt>"` - explicit agent execution command
  - `waypoint "<prompt>"` - shorthand (any unrecognized command is treated as an agent prompt)
  - `waypoint doctor` - verify agent configuration and isolation invariants
- **Agent Isolation** - complete isolation from global Codex installations
  - All agent data stored in `~/.config/waypoint/codex` (never `~/.codex`)
  - All API requests routed through Waypoint proxy (never `api.openai.com`)
  - Runtime verification of isolation invariants
- **Agent Configuration**
  - `WAYPOINT_CODEX_HOME` - override agent data directory
  - `WAYPOINT_BASE_URL` - override API endpoint
  - `WAYPOINT_API_KEY` - override authentication
  - `WAYPOINT_DEFAULT_MODEL` - set default model for agent
- **Agent CLI Options**
  - `--model, -m <model>` - specify model for agent execution
  - `--auto` - enable full-auto approval mode
  - `--suggest` - require approval for all actions (default)
  - `--no-network` - disable network access in sandbox
  - `--cwd, -d <directory>` - set working directory
- **waypoint status command** - added as alias to `waypoint stat` for convenience
- **API key support in health checks** - health checks now include Authorization headers when endpoints have apiKey configured
- **On-demand health checks** - `waypoint ls` now refreshes endpoint health status before displaying (use `--no-check` to skip)
- **Health check logging** - verbose output showing status codes and error details during health checks
- **App icon & favicon** - Custom Waypoint icon in multiple sizes (16, 32, 180, 192, 512px) with apple-touch-icon support
- **Markdown rendering** in chat responses with full GitHub Flavored Markdown support
- **Mermaid diagram support** - code blocks with `mermaid` language are rendered as interactive diagrams
- **Collapsible thinking blocks** - `<think>...</think>` content is displayed in a collapsible "Thinking process" section
- **Copy raw button** - hover over any assistant message to copy the raw markdown content
- **Code block copy buttons** - each code block has a copy button with syntax highlighting

### Fixed

- **ERR_HTTP_HEADERS_SENT crash** - server no longer crashes when timeouts occur during streaming; checks if headers are already sent before attempting error responses
- **Stale health status** - CLI commands now show real-time endpoint health instead of cached status
- **Health check accuracy** - changed logic to only consider 2xx responses as "up" (404 and 403 now correctly mark endpoints as "down")
- **Models API filtering** - `/v1/models` now only returns models from healthy endpoints
- **Timeout handling** - added comprehensive error classification for undici timeout errors (UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT, UND_ERR_CONNECT_TIMEOUT)
- **Stream error handling** - added handling for premature stream closures (ERR_STREAM_PREMATURE_CLOSE, EPIPE, ECONNABORTED)
- **MCP Accept header** - fixed MCP client to send `Accept: application/json, text/event-stream` per Streamable HTTP spec
- **MCP SSE response parsing** - added proper parsing for `event: message\ndata: {...}` response format
- **Tool choice compatibility** - removed `tool_choice: "auto"` from requests for vLLM backend compatibility
- **MCP auto-connect on startup** - tools are now discovered automatically when Waypoint starts, fixing "Tool not found" errors after restart
- **Thinking block parsing** - handles responses that start with thinking content without opening `<think>` tag (common with Qwen3 models)
- **Mermaid rendering errors** - added `suppressErrorRendering`, debounced rendering (300ms), and DOM cleanup to prevent error SVGs from appearing during streaming
- **Chat input jumping** - replaced `scrollIntoView` with direct `scrollTop` manipulation and `requestAnimationFrame` for smooth, jitter-free auto-scrolling
- **Mermaid re-triggering** - wrapped `MessageContent` component with `memo` to prevent unnecessary re-renders when typing in chat box

### Changed

- **Health check timeouts** - increased background health checker timeout from 2s to 5s for more reliable checks
- **TypeScript compilation** - excluded `src/engine` directory from build to avoid third-party code errors

- **ThinkingBlock overflow** - added horizontal scroll for long lines in thinking block content
- **Scroll behavior** - only auto-scrolls when user is near bottom (within 150px), allowing users to scroll up without jumping back

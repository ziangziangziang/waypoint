# AGENTS.md — Waypoint Phase 2 Contributor Guide (Humans + AI Agents)

This file defines how to work in the Waypoint repo safely and consistently. It’s written for both human contributors and AI coding agents.

## Project goal

Waypoint is evolving from a CLI-managed reverse proxy into a **local AI gateway** that provides:

- OpenAI-compatible proxy routes (LLM + diffusion + audio)
- A React/shadcn playground UI (served by Fastify)
- MCP-powered agentic workflows (tool discovery + tool execution)
- File-based persistence (sessions, stats, images)
- Real-time statistics dashboard
- **Backward compatibility** with existing CLI + proxy behavior

---

## Expected repository layout

```

waypoint/
├── ui/                          # NEW: React frontend
│   ├── src/
│   │   ├── api/                 # API client layer
│   │   ├── components/          # Reusable UI components
│   │   ├── pages/               # Playground, Dashboard, Settings
│   │   ├── hooks/               # Custom React hooks
│   │   ├── stores/              # State management
│   │   └── styles/              # Design system, Tailwind config
│   ├── package.json
│   └── vite.config.ts
├── src/
│   ├── routes/
│   │   ├── images.ts            # NEW: /v1/images/*
│   │   ├── audio.ts             # NEW: /v1/audio/*
│   │   ├── responses.ts         # NEW: /v1/responses shim
│   │   ├── sessions.ts          # NEW: Playground sessions API
│   │   ├── mcp.ts               # NEW: MCP server management
│   │   └── stats.ts             # ENHANCED: Detailed statistics
│   ├── middleware/
│   │   ├── requestStats.ts      # NEW: Metrics collection
│   │   └── auth.ts              # NEW: Auth placeholder
│   ├── mcp/
│   │   ├── client.ts            # NEW: MCP HTTP client
│   │   ├── registry.ts          # NEW: Server registry
│   │   └── discovery.ts         # NEW: Tool discovery
│   ├── workers/
│   │   ├── configWatcher.ts     # NEW: Hot-reload
│   │   └── statsRotation.ts     # NEW: Log cleanup
│   └── storage/
│       ├── statsRepository.ts   # NEW: Stats persistence
│       ├── sessionRepository.ts # NEW: Chat sessions
│       └── imageCache.ts        # NEW: AIGC image LRU cache
└── cli/
└── index.ts                 # ENHANCED: mcp, logs, stats commands

````

If the actual structure differs, adapt these guidelines to match the codebase, but keep concepts consistent.

---

## Non-negotiable principles

1. **Backward compatibility first**
   - Existing CLI commands and proxy behavior must continue to work.
   - If behavior must change, gate it behind config flags and keep defaults compatible.

2. **Cross-platform filesystem safety**
   - Use `os.homedir()` + `path.join(...)`.
   - Ensure directories exist before writing.
   - Prefer atomic writes (write temp → rename) for JSON/YAML where practical.

3. **No secrets in logs**
   - Never log API keys, auth headers, full prompts, or user content by default.
   - Debug logging must be opt-in and redact aggressively.

4. **Deterministic, observable behavior**
   - Prefer structured logs and explicit error responses.
   - Be careful with watchers, streaming, and retries (avoid infinite loops).

---

## Development workflow

### Install & run (use the repo’s lockfile)
Use the package manager indicated by the lockfile:
- `pnpm-lock.yaml` → `pnpm i`
- `package-lock.json` → `npm ci`
- `yarn.lock` → `yarn install --frozen-lockfile`

Typical scripts you should prefer (if present):
- `lint`, `format`, `typecheck`, `test`
- `dev` / `start` for server
- `ui:dev` / `ui:build` for UI (or `cd ui && ...`)

### Before you open a PR
- Run lint + typecheck + tests (or closest equivalents).
- Validate:
  - proxy routes still work for existing paths
  - CLI commands still function (especially add/edit/rm flow)
  - UI builds and is served at `/ui/*` with SPA fallback

---

## Implementation guidelines by subsystem

## 1) Routes & OpenAI-compat coverage

**Pattern:** each route file should mirror `src/routes/chat.ts` style and error conventions.

- `src/routes/images.ts`
  - `POST /v1/images/generations` → diffusion endpoints
- `src/routes/audio.ts`
  - `POST /v1/audio/transcriptions`
  - `POST /v1/audio/speech`
- `src/routes/responses.ts`
  - Compatibility shim translating “responses” API semantics to chat completions  - **SSE Streaming**: When `stream: true`, returns proper Server-Sent Events:
    - `event: response.created` - initial response metadata
    - `event: response.output_item.done` - for each output (messages, tool calls)
    - `event: response.completed` - final response with usage stats
  - **Tool format transformation**: Converts Codex tools to OpenAI function calling format
  - **Content type mapping**: Uses `output_text` (Codex) instead of `text` (OpenAI)- Extend shared types (e.g., `src/types.ts`)
  - `ImageGenerationRequest`
  - `AudioRequest` / transcription + speech request shapes
  - Response types matching OpenAI expectations where possible
- Update router selection logic (e.g., `src/router.ts`)
  - Add endpoint type filtering: `llm | diffusion | audio`
  - Ensure default behavior remains unchanged unless explicitly configured

**Error handling**
- Preserve OpenAI-like error envelope where possible:
  - consistent `error.message`, `error.type`, `error.code`
- Avoid leaking upstream/internal URLs in user-facing errors unless debug mode is enabled.

---

## 2) Statistics tracking (7-day window, 30-day rotation)

**Middleware**
- `src/middleware/requestStats.ts`
  - Capture:
    - latency (start/end)
    - request/response byte sizes
    - token usage:
      - prefer `usage` fields when available
      - otherwise estimate from text length (method must be stable + documented)
  - Must not break streaming responses.

**Storage**
- `src/storage/statsRepository.ts`
  - Store JSONL under `~/.cache/waypoint/` with daily rotation (e.g., `stats-YYYY-MM-DD.jsonl`)
  - Writes should be append-only and resilient to partial lines.

**API**
- `src/routes/stats.ts`
  - `GET /admin/stats`
  - Aggregations:
    - p50/p95/p99 latency
    - tokens/hour
    - error rates
    - per-model breakdown
  - Keep it fast: avoid loading 30 days into memory if not needed.

**Rotation**
- `src/workers/statsRotation.ts`
  - Purge files older than 30 days
  - Must tolerate missing dirs/files and continue safely

---

## 3) Config hot-reload

- `src/workers/configWatcher.ts`
  - Use `fs.watch()` with debounce (~500ms)
  - Handle “rename” events and editor atomic-save patterns
- Repositories / config loader should expose `reload()` and emit `config:updated`
- Router selection logic should subscribe to config updates and refresh endpoint cache
- CLI changes (`cli/index.ts`)
  - `add/edit/rm` should not prompt for restart when hot-reload is active

**Watchers are fragile**
- Don’t assume one event == one change.
- Always re-read config on debounce fire, validate, then swap in.

---

## 4) UI package scaffold (Vite + React + shadcn/ui)

- UI lives in `ui/`
- Follow `ui.instructions.md` design direction:
  - bold typography
  - distinctive palette
  - refined animations
- Fastify serves built assets:
  - `@fastify/static` at `/ui/*`
  - SPA fallback for client routes

**API client**
- `ui/src/api/` should wrap:
  - proxy endpoints (`/v1/...`)
  - admin endpoints (`/admin/...`)
- Centralize:
  - base URL handling
  - JSON parsing
  - error normalization
  - SSE/stream helpers for chat streaming

---

## 5) Playground (chat + sessions + AIGC)

- `ui/src/pages/Playground.tsx`
  - model selector
  - message composer
  - streaming display
  - image input (drag/drop/paste/file → base64 for VL models)

**Sessions**
- Stored under: `~/.cache/waypoint/sessions/{sessionId}.json`
- Backend CRUD:
  - `src/routes/sessions.ts` + `src/storage/sessionRepository.ts`

**AIGC outputs**
- Detect image responses
- Save image to `~/.cache/waypoint/images/{hash}.png`
- Record local path in session
- Implement LRU eviction:
  - configurable max size (default 1GB)
  - UI warning/alert when eviction occurs
- Prefer storing metadata (hash, size, createdAt, model) to support dashboard stats later.

---

## 6) Dashboard (real-time stats)

- `ui/src/pages/Dashboard.tsx`
  - latency distributions
  - request volume
  - token usage
  - error rates
- Use Recharts or lightweight SVG charts
- Auto-refresh:
  - configurable interval (default 30s)
- Health cards:
  - consume existing `/admin/health`
  - live/degraded/down status

---

## 7) MCP client + registry + discovery

- `src/mcp/client.ts`
  - MCP streamable-HTTP client protocol
  - auto-reconnect (bounded backoff)
- `src/mcp/registry.ts`
  - store server list in `~/.cache/waypoint/mcp-servers.yaml`
- `src/mcp/discovery.ts`
  - on connect: `tools/list` discovery
  - cache discovered tools with source server metadata
- `src/routes/mcp.ts`
  - `/admin/mcp/servers` CRUD
  - `/admin/mcp/tools` list discovered tools

CLI additions (`cli/index.ts`)
- `waypoint mcp add <url>`
- `waypoint mcp list`
- `waypoint mcp rm <id>`

**MCP safety**
- Validate tool schemas.
- Bound payload sizes and timeouts.
- Surface tool execution errors clearly to the user.

---

## 8) Agentic playground mode (UI)

- `ui/src/components/AgentMode.tsx`
  - toggle tool usage
- Tool call rendering:
  - tool name + args
  - streaming execution progress
  - final result block
- Tool picker sidebar:
  - list tools from `/admin/mcp/tools`
- Agentic loop:
  - LLM response → tool call → MCP execute → append result → continue

**Loop control**
- Hard cap tool-call iterations per user message.
- Allow user to cancel.
- Record tool calls/results in session history.

---

## 9) CLI upgrades

- `waypoint logs [-f]` tail `~/.cache/waypoint/waypoint.log`
- `waypoint stats [--window=7d]` stats summary in terminal
- Service process:
  - graceful shutdown on SIGTERM
- Startup banner:
  - listening URL
  - registered endpoints count

---

## 10) Auth-ready architecture (no-op today)

- `src/middleware/auth.ts`
  - no-op middleware
  - include `req.user` typing placeholder
- Config:
  - add `authEnabled: boolean` default `false`
- Wrap:
  - `/admin/*` and `/ui/*` behind auth check (enforced only when enabled)
- Document extension points in README

---

## Coding conventions

- TypeScript:
  - prefer explicit types at module boundaries (routes, storage, MCP)
  - avoid `any` (use `unknown` + validation)
- Fastify:
  - routes should be isolated plugins
  - keep handlers thin; move logic to services/repositories
- Streaming:
  - don’t buffer large responses in memory
  - always handle client disconnects
- Storage:
  - prefer append-only JSONL for metrics
  - use stable JSON shapes for sessions

---

## Definition of Done (per change)

A change is “done” when:
- Typecheck passes
- Lint passes (if configured)
- Basic runtime sanity check succeeds:
  - server boots
  - at least one proxy request works
  - UI builds (if UI touched)
- Backward compatibility preserved or guarded by config flag
- New endpoints documented (README or route docs as appropriate)

---

## AI agent capability: frontend-design

Use this capability when building **web components, pages, or applications** under `ui/` (or when adjusting UI aesthetics). The goal is to produce **distinctive, production-grade** interfaces that avoid generic “AI slop” aesthetics.

```markdown
---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: AI agents are capable of extraordinary creative work. Don't hold back—commit fully to a distinctive vision.
````

---

## Notes for AI agents

* Prefer small, reviewable commits.
* Don’t refactor unrelated code “for cleanliness” unless it removes real duplication blocking the plan.
* When extending OpenAI compatibility:

  * mirror request/response shapes
  * document intentional deviations
* If uncertain about existing patterns, inspect:

  * `src/routes/chat.ts`
  * router selection logic
  * existing storage helpers in `src/storage/*`

```
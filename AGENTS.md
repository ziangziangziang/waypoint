# Waypoint Contributor Guardrails

Purpose and scope:
- Applies to the entire repo.
- Preserve core functionality while evolving features.

Core invariants (must not break):
- MCP:
  - `/mcp` endpoint exists and is localhost-only.
  - File-first policy remains default for binary tools.
  - Tool outputs remain structured as `{ ok: true|false, ... }`.
  - File outputs must be workspace-relative (no `/tmp` by default).
- Playground UI:
  - Image/chat upload flows remain functional.
  - Thinking/streaming behaviors are preserved.
  - No regressions to basic chat/call flows.
- Reverse proxy:
  - `/v1/*` stays OpenAI-compatible.
  - No breaking request/response changes without migration notes.
- Providers/pools:
  - Capability routing remains consistent (input/output requirements).
  - Model selection logic unchanged unless updated with tests.

Change discipline:
- MCP tool contract changes must update:
  - `docs/mcp-service.md`
  - `docs/mcp-guidelines.md`
  - relevant tests in `tests/mcp*.test.ts`
- OpenAI route changes must update relevant docs and regression tests.
- UI changes affecting chat/call/image flows must add a targeted test or a manual verification checklist in PR notes.

Default output path rule:
- Tool outputs must write under the workspace (default `./.waypoint/generated-images`).
- Reject `output_path`/`output_dir` outside the workspace.

Quick pointers (where to look first):
- MCP service: `src/mcp/service.ts`
- MCP policy: `src/mcp/policy.ts`
- Playground: `ui/src/pages/AgentPlayground.tsx`
- Reverse proxy: `src/routing/router.ts` and `src/routes/*`
- Providers/pools: `src/providers/*`, `src/pools/*`

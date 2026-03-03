# Changelog

All notable changes to Waypoint are documented here.

## [Unreleased]

### Changed

- CLI canonical provider/model groups now use one-hop commands:
  - `waypoint providers`
  - `waypoint models <providerId>`
  - `waypoint models show <providerId>/<modelId>`
- Added legacy rewrite shims with deprecation warnings for common old forms (for example `waypoint provider model ls <providerId>`).
- Added `WAYPOINT_NO_WARN=1` support to suppress legacy rewrite warnings in scripts.
- Updated CLI docs to prefer canonical `providers`/`models` command paths.

### Added

- New CLI utilities:
  - `cli/legacyRewrite.ts`
  - `cli/modelRef.ts`
- New tests:
  - `tests/cliLegacyRewrite.test.ts`
  - `tests/modelRef.test.ts`

## [0.4.2] - 2026-02-23

### Added

- Model-level capability classification (`input`/`output` modalities) on model mappings.
- `/v1/models` now returns `capabilities` per model while keeping `endpoint_type` for compatibility.
- Capability inference engine with config-first precedence and heuristic fallback.
- Benchmark mode expansion to embeddings, image generation, and audio (speech/transcription), with per-mode assertions.
- Benchmark skip+warn behavior for unconfigured model families plus per-mode summary metrics.

### Changed

- Route eligibility now supports capability requirements (`requiredInput`/`requiredOutput`) in addition to endpoint type.
- Default model selection prefers capability-matching models before endpoint-type fallback.
- Playground model picker labels now show capability tags when available (e.g. `text+image->text`).

## [0.4.1] - 2026-02-23

### Added

- Config-first benchmark system with profile support (`--config`, `--profile`).
- Benchmark baseline comparison support (`--baseline`) for soft regression warnings.
- New benchmark artifact pair per run (`.json` + `.txt`) with gate outcomes and per-scenario measured samples.
- Example benchmark config and scenario files under `examples/`.

### Changed

- Benchmark runner now executes warmup + measured runs and reports pass rate per scenario.
- Scenario schema validation now enforces required fields and emits location-aware error messages.
- Agent benchmark loop now enforces per-tool timeout and max-iteration failure reason (`max_iterations_reached`).

### Fixed

- Benchmark gate semantics now separate hard failures (exit code 1) from soft warnings (exit code 0).

## [0.4.0] - 2026-02-23

### Changed

- Realigned product scope around **model proxy + playground + benchmark**.
- Removed embedded CLI coding-agent runtime surface (`agent`, `run`, `doctor`, and implicit prompt execution).
- Added `waypoint bench` / `waypoint benchmark` command for lightweight benchmarking.
- Added built-in smoke suite and file-driven scenario support (`.json`, `.jsonl`, `.yaml`).
- Added benchmark artifacts under `$WAYPOINT_DIR/benchmarks` (or `~/.config/waypoint/benchmarks`).
- Updated docs to position Waypoint as a local gateway for external clients (including Opencode).

### Added

- `docs/opencode.md` for proxy-only Opencode integration.
- `docs/benchmark.md` for benchmark scenarios, assertions, and artifact output.

### Fixed

- Image cache now accepts both raw base64 and `data:image/...;base64,...` payloads.
- New sessions now default to cache-backed image references (`storageVersion: 2`) to avoid session JSON bloat.
- MCP startup/discovery errors are now concise by default, with optional verbose logs via `WAYPOINT_DEBUG_ERRORS=1`.

## [0.3.0] - 2026-01-29

### Added

- Responses API compatibility and streaming support.
- MCP tool-call compatibility improvements.
- Waypoint branding and runtime integration updates.

### Fixed

- Model-list compatibility improvements (`slug` and compatibility fields).
- Localhost login bypass behavior for proxied local deployments.

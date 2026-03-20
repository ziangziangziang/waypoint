# Waypoint Benchmark

Waypoint benchmark now has two roles:

- `showcase`: a live, user-visible replay of curated examples
- `diagnostic`: the older internal smoke/capability/regression path

Default behavior is showcase-first.

## Quick start

```bash
# Default run: showcase suite, one visible replay per example
waypoint bench

# List showcase examples
waypoint bench --list-examples

# Run one example
waypoint bench --example showcase-agent-tool-call

# Pin a model for a showcase example
waypoint bench --suite showcase --example showcase-responses-basic --model smart

# Run a diagnostic suite
waypoint bench --mode diagnostic --suite pool_smoke

# Add file-driven scenarios
waypoint bench --scenario ./examples/scenarios/custom.yaml

# Compare with a previous diagnostic run
waypoint bench --mode diagnostic --baseline ~/.config/waypoint/benchmarks/bench-2026-02-23T12-00-00-000Z.json
```

## CLI options

- `--suite <name>` built-in suite. Public default is `showcase`.
- `--example <id>` run one built-in example from the selected suite.
- `--list-examples` list built-in examples and exit.
- `--mode <name>` `showcase` or `diagnostic`.
- `--scenario <path>` scenario file (`.json`, `.jsonl`, `.yaml`, `.yml`).
- `--model <name>` force one model for all scenarios.
- `--out <path>` output file (`.json`/`.txt`) or output directory.
- `--config <path>` benchmark config file (YAML or JSON).
- `--profile <name>` config profile (default: `local`).
- `--baseline <path>` previous benchmark report for p95/throughput deltas.
- `--update-cap-cache` persist capability findings to `$WAYPOINT_DIR/capabilities`.
- `--cap-ttl-days <n>` capability TTL override for freshness (default `7`).

## Showcase examples

The `showcase` suite is the release-facing path. It is built from Opencode-style real usage:

- plain chat completion
- `/v1/responses` compatibility
- agent tool calling
- multi-step agent loop
- image generation
- audio + text turn

Showcase behavior:

- sequential only
- one visible replay per scenario
- request/response trace is the main artifact
- verdict explains what passed or failed
- raw payloads stay in the live event stream; persisted artifacts keep sanitized traces

## Diagnostic suites

The older suites remain for engineering use:

- `smoke`
- `proxy`
- `agent`
- `pool_smoke`
- `omni_call_smoke`
- `capabilities`

Diagnostic behavior:

- profile-driven warmup and measured runs
- pass-rate and latency summaries
- optional baseline regression warnings
- optional capability cache updates

Concurrency is no longer part of the benchmark story.

## Scenario schema

Required fields:

- `id: string`
- `mode: "chat" | "agent" | "responses" | "embeddings" | "image_generation" | "audio_transcription" | "audio_speech" | "omni_call"`

Mode-specific required fields:

- `chat | agent | responses | image_generation`: `prompt`
- `embeddings`: `input`
- `audio_transcription`: `audioFile`
- `audio_speech`: `inputText`, `voice`
- `omni_call`: `audioFile`

Useful showcase metadata:

- `title`
- `summary`
- `userVisibleGoal`
- `exampleSource`
- `inputPreview`
- `successCriteria`
- `expectedHighlights`
- `requiresAvailableTools`

Assertions:

- generic: `statusCode`, `maxLatencyMs`
- chat/agent/responses: `contains`, `notContains`
- agent: `minToolCalls`, `maxToolCalls`, `requiredToolNames`
- embeddings: `minItems`, `minVectorLength`
- image generation: `minImages`
- audio transcription: `containsText`, `notContainsText`
- audio speech: `minBytes`, `contentType`

Validation behavior:

- schema errors fail fast with `file + index + field`
- unknown fields become warnings

### Example: showcase responses scenario

```json
{
  "id": "responses-demo",
  "mode": "responses",
  "title": "Responses Demo",
  "userVisibleGoal": "Show Responses API compatibility.",
  "prompt": "List two reasons to use a local AI gateway.",
  "assertions": {
    "statusCode": 200
  }
}
```

### Example: showcase tool-calling scenario

```json
{
  "id": "agent-tool-demo",
  "mode": "agent",
  "title": "Tool Calling",
  "prompt": "Use one available tool, then summarize what you learned.",
  "requiresAvailableTools": true,
  "assertions": {
    "statusCode": 200,
    "minToolCalls": 1
  }
}
```

## Artifacts and UI behavior

Each run writes:

- `bench-<timestamp>.json`
- `bench-<timestamp>.txt`

Reports now include:

- run metadata and effective config
- per-scenario results
- sanitized scenario details for history
- live-show traces for each scenario
- verdict strings and tool usage summaries
- optional capability matrix

The Benchmark UI is optimized for:

- selecting one example
- watching the live trace
- reading the exact scenario input
- inspecting tool calls and tool results
- seeing the final verdict clearly

## Verification checklist

- `waypoint bench` defaults to showcase behavior.
- `waypoint bench --list-examples` lists human-readable examples.
- Benchmark UI loads showcase examples by default.
- A showcase run shows scenario input, wire request, response, and verdict.
- Tool-driven examples are skipped clearly when no MCP tools are available.
- Diagnostic suites still produce capability and regression information.

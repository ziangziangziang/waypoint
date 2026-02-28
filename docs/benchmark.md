# Waypoint Benchmark

Waypoint benchmark is config-driven and capability-aware.

## Quick start

```bash
# Default run: profile=local, suite=smoke
waypoint bench

# Explicit profile/config
waypoint bench --config ./examples/benchmark.config.yaml --profile ci

# Run built-in suite + custom scenarios
waypoint bench --suite smoke --scenario ./examples/scenarios/custom.yaml

# Smart pool routing smoke check
waypoint bench --suite pool_smoke

# Omni call smoke check (audio + text turn)
waypoint bench --suite omni_call_smoke

# Compare with baseline for soft regression warnings
waypoint bench --baseline ~/.config/waypoint/benchmarks/bench-2026-02-23T12-00-00-000Z.json
```

## CLI options

- `--suite <name>` built-in suite (`smoke`, `proxy`, `agent`, `pool_smoke`, `omni_call_smoke`)
- `--scenario <path>` scenario file (`.json`, `.jsonl`, `.yaml`, `.yml`)
- `--model <name>` force one model for all scenarios
- `--out <path>` output file (`.json`/`.txt`) or output directory
- `--config <path>` benchmark config file (YAML or JSON)
- `--profile <name>` config profile (default: `local`)
- `--baseline <path>` previous benchmark report for p95/throughput deltas

## Config resolution order

1. CLI flags (`--suite`, `--scenario`, `--model`, `--out`, `--profile`, `--baseline`)
2. Explicit `--config`
3. `$WAYPOINT_DIR/benchmark.config.yaml` (if present)
4. Internal defaults

## Internal defaults

- `requestTimeoutMs: 120000`
- `toolTimeoutMs: 15000`
- `maxIterations: 6`
- `temperature: 0`
- `max_tokens: 512`
- `concurrency: 1`

Profiles:

- `local`: `warmupRuns=1`, `measuredRuns=3`, `minScenarioPassRate=1.0`
- `ci`: `warmupRuns=2`, `measuredRuns=5`, `minScenarioPassRate=1.0`

## Scenario file formats

File shapes:

- array of scenarios
- object with `scenarios` array

File types:

- `.json`
- `.jsonl`
- `.yaml` / `.yml`

## Scenario schema (v1)

Required fields (all modes):

- `id: string`
- `mode: "chat" | "agent" | "embeddings" | "image_generation" | "audio_transcription" | "audio_speech" | "omni_call"`

Mode-specific required fields:

- `chat | agent`: `prompt`
- `embeddings`: `input` (`string | string[]`)
- `image_generation`: `prompt`
- `audio_transcription`: `audioFile`
- `audio_speech`: `inputText`, `voice`
- `omni_call`: `audioFile` (optional `prompt`)

Common optional fields:

- `model`, `timeoutMs`, `assertions`
- `temperature`, `max_tokens` (chat/agent)
- `tools`, `maxIterations` (agent)
- `n`, `size` (image_generation)
- `response_format` (audio_speech)

Assertions:

- Generic: `statusCode`, `maxLatencyMs`
- Chat/agent: `contains`, `notContains`, `minToolCalls`, `maxToolCalls`
- Embeddings: `minItems`, `minVectorLength`
- Image generation: `minImages`
- Audio transcription: `containsText`, `notContainsText`
- Audio speech: `minBytes`, `contentType`
- Omni call: uses generic text assertions (`contains`, `notContains`) and records `audio_output=yes|no` in output preview

Validation behavior:

- schema errors fail fast with `file + index + field`
- unknown fields are warnings (not hard failures)

### Example: embeddings

```json
{
  "id": "embed-basic",
  "mode": "embeddings",
  "input": ["waypoint", "proxy"],
  "assertions": {
    "minItems": 2,
    "minVectorLength": 1,
    "statusCode": 200
  }
}
```

### Example: image generation

```json
{
  "id": "img-basic",
  "mode": "image_generation",
  "prompt": "A minimal gateway icon",
  "assertions": {
    "minImages": 1,
    "statusCode": 200
  }
}
```

### Example: audio speech

```json
{
  "id": "tts-basic",
  "mode": "audio_speech",
  "inputText": "Waypoint benchmark",
  "voice": "alloy",
  "assertions": {
    "minBytes": 1,
    "statusCode": 200
  }
}
```

### Example: omni call

```json
{
  "id": "omni-call-basic",
  "mode": "omni_call",
  "audioFile": "examples/scenarios/assets/omni-call-sample.wav",
  "prompt": "Transcribe and summarize this audio.",
  "assertions": {
    "statusCode": 200
  }
}
```

## Execution behavior

Per scenario:

- warmup runs (discarded)
- measured runs (reported)

Per executed scenario report includes:

- `passRate`, `avg/p50/p95/p99 latency`
- token totals
- tool-call totals
- throughput (`tokens/s`)
- pool routing metrics (`candidateAttempts`, `failovers`, `rateLimitSwitches`, `distinctProviders`, `distinctModels`)

If a scenario has no compatible model family configured:

- scenario is marked `skipped`
- benchmark continues
- warning is added to report

Agent safeguards:

- strict `maxIterations`
- per-tool timeout
- cap reached -> `max_iterations_reached`

## Gates and exit policy

Hard gates (exit code `1`):

- smoke success rate below `gates.hard.smokeMinSuccessRate` (for executed smoke scenarios)
- any executed scenario `passRate < minScenarioPassRate`
- schema/validation errors

Soft gates (warning only, exit code `0`):

- baseline p95 regression above `gates.soft.maxP95RegressionPct`
- baseline throughput drop above `gates.soft.maxThroughputDropPct`

## Artifacts

Default output path:

- `$WAYPOINT_DIR/benchmarks`
- fallback: `~/.config/waypoint/benchmarks`

Per run:

- `bench-<timestamp>.json`
- `bench-<timestamp>.txt`

Report includes:

- run metadata + effective config
- `total`, `executed`, `skipped`, `succeeded`, `failed`
- per-mode summary
- per-scenario results + measured samples
- gate outcomes
- top failure reasons + warnings

## Recommended config template

See `/Users/zziang/Documents/projects/vibeCoding/Agents/waypoint/examples/benchmark.config.yaml`.

# MCP Service (`/mcp`)

Waypoint provides a built-in MCP server at:

- `POST /mcp` (Streamable HTTP transport)
- localhost only (`localhost`, `127.0.0.1`, `::1`)

Policy authority: [`docs/mcp-guidelines.md`](./mcp-guidelines.md)

## Client flow

1. `initialize`
2. `notifications/initialized`
3. `tools/list`
4. `tools/call`

## Tool: `generate_image`

Generate image(s) from text using Waypoint's diffusion routing.

Governance note: this tool follows the file-first, data-opt-in policy from [`docs/mcp-guidelines.md`](./mcp-guidelines.md).

### Server environment guards

`generate_image` file-output path validation can be pinned with server env vars:

- `WAYPOINT_MCP_OUTPUT_ROOT` (optional, absolute path):
  - hard base root for resolving and validating `output_path` / `output_dir`
  - defaults to server `process.cwd()` when unset
- `WAYPOINT_MCP_OUTPUT_SUBDIR` (optional, relative path):
  - narrows allowed output paths to `<WAYPOINT_MCP_OUTPUT_ROOT>/<subdir>`
  - example: `work`
- `WAYPOINT_MCP_STRICT_OUTPUT_ROOT` (optional, `true|false`, default `false`):
  - when `true`, `WAYPOINT_MCP_OUTPUT_ROOT` is required and must be absolute
  - invalid/missing strict config returns typed `invalid_request` errors

Example for pinning outputs to a specific project work tree:

```bash
export WAYPOINT_MCP_OUTPUT_ROOT=/path/to/project
export WAYPOINT_MCP_OUTPUT_SUBDIR=work
export WAYPOINT_MCP_STRICT_OUTPUT_ROOT=true
```

### Input fields

- `prompt` (required, string)
- `model` (optional, string)
- `n` (optional, integer `1..4`)
- `size` (optional, string)
- `quality` (optional, string)
- `style` (optional, string)
- `response_format` (optional, `"url"` or `"b64_json"`)
- `output_path` (optional, string):
  - file path for output
  - for `n > 1`, include `{index}` in path (for example `./out/image-{index}.png`)
- `output_dir` (optional, string):
  - directory for generated files (`image-<created>-<index>.<ext>`)
- `include_data` (optional, boolean):
  - include `url`/`b64_json` in response
  - default is `false` when writing to file (`output_path` or `output_dir` is set)
  - default is `true` otherwise

### File-output behavior

When `output_path` or `output_dir` is set, the tool writes image bytes to disk and returns file metadata:

- `file_path`
- `mime_type`
- `bytes`

This mode is recommended for agents to avoid large base64 blobs consuming context window.

Implementation note: in file-output mode, `generate_image` forces upstream `response_format` to `"b64_json"` to ensure bytes are always available for writing, even if caller passes `"url"`.

### Validation rules

- `output_path` and `output_dir` are mutually exclusive.
- If `n > 1` and `output_path` is used, `output_path` must include `{index}`.
- `output_path` and `output_dir` must resolve under the configured MCP output root:
  - default root is `process.cwd()`
  - overridden by `WAYPOINT_MCP_OUTPUT_ROOT`
  - optionally narrowed by `WAYPOINT_MCP_OUTPUT_SUBDIR`
  - relative paths are resolved against `WAYPOINT_MCP_OUTPUT_ROOT` when set

### Response notes

- Success: `ok: true` with `images[]`.
- Error: `ok: false` with typed `error` (`invalid_request`, `no_diffusion_model`, `upstream_error`, etc).

## Tool: `understand_image`

Analyze an image using a vision-capable text model and return verbose structured analysis.

### Input fields

- `image_path` (optional, string; local file path)
- `image_url` (optional, string; supports `http(s)` or `data:` URL)
- `instruction` (optional, string; default: general OCR/object/scene/detail analysis)
- `model` (optional, string; auto-selects best vision-capable text-output model when omitted)
- `max_tokens` (optional, integer `1..4096`)
- `temperature` (optional, number `0..2`)

Validation:

- Exactly one image source is required: `image_path` XOR `image_url`.

### Response shape

Success:

- `ok`
- `model`
- `analysis`:
  - `answer`
  - `ocr_text`
  - `objects`
  - `scene`
  - `notable_details`
  - `safety_notes`
- `raw_text`
- `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`)

Error:

- `ok: false`
- typed `error` (`invalid_request`, `no_vision_model`, `upstream_error`, ...)

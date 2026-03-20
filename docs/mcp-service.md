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
When `image_path` or `image_url` is provided, the tool performs image-to-image editing.

Governance note: this tool follows the workspace-only, file-first policy from [`docs/mcp-guidelines.md`](./mcp-guidelines.md).

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
- `image_path` (optional, string; local file path for image-to-image editing)
- `image_url` (optional, string; supports `http(s)` or `data:` URL for image-to-image editing)
- `workspace_root` (required, string; absolute path to the active repo/workspace for file output)
- `n` (optional, integer `1..4`)
- `size` (optional, string)
- `quality` (optional, string)
- `style` (optional, string)
- `response_format` (optional, `"url"` or `"b64_json"`)
- `output_path` (optional, string):
  - relative file path under `workspace_root`
  - for `n > 1`, include `{index}` in path (for example `./out/image-{index}.png`)
- `output_dir` (optional, string):
  - relative directory under `workspace_root` for generated files (`image-<created>-<index>.<ext>`)
- `include_data` (optional, boolean):
  - include `url`/`b64_json` in detailed structured output
  - default is `false`

### File-output behavior

`generate_image` always writes image bytes to disk and returns workspace-relative file metadata:

- `file_path`
- `file_paths` when multiple images are generated
- `mime_type`
- `bytes`

This keeps generated artifacts inside the active workspace and avoids large base64 blobs consuming context window.

When `workspace_root` is provided:

- relative `output_path` / `output_dir` are resolved against `workspace_root`
- if neither `output_path` nor `output_dir` is provided, Waypoint writes to `./.waypoint/generated-images`
- returned `file_path` values are relative to `workspace_root`, not absolute paths

Implementation note: in file-output mode, `generate_image` forces upstream `response_format` to `"b64_json"` to ensure bytes are always available for writing, even if caller passes `"url"`.

### Validation rules

- `output_path` and `output_dir` are mutually exclusive.
- `image_path` and `image_url` are mutually exclusive.
- `workspace_root` is required and must be an absolute readable directory.
- If `n > 1` and `output_path` is used, `output_path` must include `{index}`.
- `output_path` and `output_dir` must be relative to `workspace_root`.
- `output_path` and `output_dir` must resolve under `workspace_root`.
- if `WAYPOINT_MCP_OUTPUT_ROOT` is configured, `workspace_root` must resolve within the configured root

### Response notes

- Success: `ok: true` with `summary`, `file_path`/`file_paths`, and detailed `artifacts[]`.
- Error: `ok: false` with typed `error` (`invalid_request`, `no_diffusion_model`, `upstream_error`, etc).

## Tool: `understand_image`

Analyze an image using a vision-capable text model and return structured text.

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
- `summary`
- `model`
- `text`
- `result`:
  - `answer`
  - `ocr_text`
  - `objects`
  - `scene`
  - `notable_details`
  - `safety_notes`
- `image_geometry` (optional for local image paths):
  - `original_width`
  - `original_height`
  - `uploaded_width`
  - `uploaded_height`
  - `scale_x`
  - `scale_y`
  - `resized`
- `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`)

For local `image_path` inputs, Waypoint may resize the uploaded image before sending it upstream. When that happens, it prepends a system instruction telling the model to report any coordinates in original-image pixels and includes `image_geometry` in the success payload for debugging and downstream correction.

Error:

- `ok: false`
- typed `error` (`invalid_request`, `no_vision_model`, `upstream_error`, ...)

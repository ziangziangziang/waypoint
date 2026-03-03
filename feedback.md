## A) Architecture options (2–3) with tradeoffs

### Option 1 — **Add `/v1/images/edits` + unify image pipeline behind a single “ImageTask” service** (recommended)

**What changes**

* Implement OpenAI-compatible **`POST /v1/images/edits`** in the gateway.
* Refactor `src/services/imageGeneration.ts` into a unified pipeline that supports:

  * text-to-image (existing `/v1/images/generations`)
  * image-to-image edit (new `/v1/images/edits`)
  * backend routing across native images APIs *and* chat-multimodal-only models (like `pcai/zimage`)
* UI chooses endpoint based on whether an input image is present.
* MCP `generate_image` adds optional `image_path` / `image_url` and calls the same unified service internally.

**Pros**

* Preserves OpenAI compatibility cleanly: generations vs edits are standard endpoints.
* Backward compatible: text-only calls remain unchanged.
* Centralizes validation + resize + routing + normalization in one place.

**Cons**

* You must support multipart parsing for `/v1/images/edits` (image file upload).
* Needs a “chat multimodal → images response” adapter for providers like zimage.

---

### Option 2 — Introduce a Waypoint-specific endpoint (e.g. `POST /internal/images`) and keep `/v1/images/*` as-is

**What changes**

* UI and MCP call a new JSON endpoint that supports `prompt + optional image_ref`.
* Gateway internally decides generate vs edit and routes.

**Pros**

* No multipart work if you accept `image_url`/`data:` only.
* One endpoint shape for all use cases.

**Cons**

* UI is no longer “OpenAI-like”.
* Adds a second public-ish API surface you must version and support.
* You still need the backend routing + normalization work.

---

### Option 3 — Route *all* image generation via chat-completions multimodal internally

**What changes**

* Even for providers that support `/images/generations` or `/images/edits`, you synthesize chat requests.

**Pros**

* One upstream “protocol” to implement.

**Cons**

* Leaves performance/features on the table for native image endpoints.
* Harder to guarantee consistent behavior vs OpenAI Images APIs.
* More brittle normalization (providers vary widely in chat image output semantics).

---

## B) Recommended option + concrete data flow (Option 1)

### Core idea

Create a **single internal image pipeline** that takes an `ImageTask` and returns a normalized `ImageResult[]`. Both HTTP endpoints and MCP call into it.

### Data flow (text-to-image)

1. **UI** calls `POST /v1/images/generations` (existing)
2. **Gateway** → `ImagePipeline.run({ kind: "generate", ... })`
3. **Router** selects a model with capability `images.generate` (or equivalent existing image-capability tag)
4. **Adapter dispatch**

   * Prefer native `/images/generations` adapter if supported
   * Otherwise fall back to chat multimodal adapter (if that model only supports chat)
5. **Normalize output** to OpenAI Images response (url/b64) + internal `ImageResult`

### Data flow (image-to-image edit)

1. **UI** calls `POST /v1/images/edits` with multipart `{ image, prompt, ... }`
2. **Gateway** parses multipart → `ImageTask { kind:"edit", inputImage: Buffer/FileRef, ... }`
3. **Validation + safety**
4. **Router** selects a model with capability `images.edit` OR (`chat.multimodal_image_input` + `image_output`)
5. **Auto-resize** input image if model has limits
6. **Adapter dispatch**

   * If provider supports native edits: call `/images/edits`
   * Else (zimage): synthesize chat-completions multimodal request and parse image output
7. **Normalize output** to OpenAI Images response + internal `ImageResult`

### Data flow (MCP `generate_image`)

1. MCP tool input: `prompt + (optional image_path|image_url)`
2. MCP service loads image (workspace-relative for `image_path`) or fetches URL (with safety rules)
3. Calls `ImagePipeline.run(...)`
4. Writes outputs to workspace-relative `output_path` / `output_dir` (path safety preserved)
5. Returns `{ ok: true|false, ... }` with normalized metadata

---

## C) Exact schema / API changes (request & response types)

### 1) MCP tool: `generate_image` input schema (additive, backward compatible)

**Current:** prompt + generation args
**Add:**

* `image_path?: string` (workspace-relative, file-first)
* `image_url?: string` (http/https or data URL; optional)
* `image_resize?: { mode?: "auto"|"none"; max_side?: number; max_pixels?: number; }` (optional; default `auto`)
* (optional) `image_mime?: "image/png"|"image/jpeg"|"image/webp"` if needed for data URLs

Rules:

* `image_path` and `image_url` are **mutually exclusive**
* If either is provided, task kind becomes **edit** (image-to-image)

**MCP response (keeps contract)**

```ts
type McpGenerateImageResponse =
  | { ok: true; images: Array<{ path: string; width?: number; height?: number; mime?: string }>; model?: string; provider?: string; warnings?: string[]; }
  | { ok: false; error: { code: string; message: string; suggestion?: string; details?: any } };
```

This preserves `{ ok: true|false, ... }` and keeps file-first output by default.

---

### 2) UI client API (`ui/src/api/client.ts`) changes

Add input image support while keeping existing `generateImage()` working.

**Suggested UI API**

```ts
type GenerateImageInput =
  | { type: "none" }
  | { type: "file"; file: File }
  | { type: "url"; url: string };

type GenerateImageParams = {
  prompt: string;
  model?: string;
  size?: string;        // keep existing
  n?: number;
  // new:
  inputImage?: GenerateImageInput; // default {type:"none"}
};

async function generateImage(params: GenerateImageParams) {
  if (params.inputImage?.type === "file") {
    // call /v1/images/edits (multipart)
  } else if (params.inputImage?.type === "url") {
    // either:
    // (a) download client-side and send as file, OR
    // (b) call a small gateway helper that fetches and edits (see note below)
  } else {
    // call /v1/images/generations (existing JSON)
  }
}
```

**Note on `url` input in UI**
OpenAI’s `/images/edits` expects a file upload, not a URL. To support URL nicely:

* either download in browser → File/Blob → multipart upload, or
* add a Waypoint-only helper field (not OpenAI standard). If you want to stay strict, prefer browser download-to-blob.

---

### 3) Gateway HTTP endpoints

**Keep existing**

* `POST /v1/images/generations` (JSON)

**Add**

* `POST /v1/images/edits` (multipart/form-data)

  * fields: `image` (file), `prompt` (string), plus compatible fields you already support (`model`, `size`, `n`, etc.)

**OpenAI-compatible response shape**

* Return the same `ImagesResponse` you already return for generations:

  * `data: [{ url }]` or `data: [{ b64_json }]`
  * plus `created`

Internally you can normalize to:

```ts
type ImageResult = {
  bytes: Buffer;
  mime: string;
  width?: number;
  height?: number;
  // optionally:
  url?: string;         // if you save and serve it
  b64_json?: string;    // if returning inline
};
```

---

### 4) Model capability metadata additions (routing + resize)

Add optional fields in the provider model registry (whatever structure you already use):

```ts
type ImageInputLimits = {
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
  maxBytes?: number;
  allowedMime?: string[];
};

type ModelCapabilities = {
  // existing:
  // chat, images, embeddings, etc...
  imagesGenerate?: boolean;
  imagesEdit?: boolean;
  chatMultimodalImageInput?: boolean;
  imageOutput?: boolean;

  imageInputLimits?: ImageInputLimits;
  preferredImageProtocol?: "images" | "chat"; // optional tie-breaker
};
```

For `pcai/zimage`, you’d set:

* `chatMultimodalImageInput: true`
* `imageOutput: true`
* `imagesEdit: true` (as a “logical capability”, even if implemented via chat adapter)
* `preferredImageProtocol: "chat"`

---

## D) Edge cases + failure modes

### Input validation edge cases

* **Both `image_path` and `image_url` provided** → `INVALID_INPUT`
* **Neither provided** → generation mode (backward compatible)
* **Unsupported image type** (e.g. GIF, SVG) → `UNSUPPORTED_IMAGE_FORMAT`
* **Image too large** (bytes) and cannot be resized under limits → `IMAGE_TOO_LARGE`
* **Corrupt image** / decode fails → `INVALID_IMAGE_DATA`
* **Remote URL fetch fails / times out** → `IMAGE_FETCH_FAILED`
* **SSRF risk**: URL points to localhost/private IP ranges → `IMAGE_URL_NOT_ALLOWED` (unless explicitly allowed in config)

### Routing edge cases

* **Selected model can generate but not accept image input** → `MODEL_NOT_CAPABLE` with suggestion:

  * “Try: waypoint models list --cap images.edit” or pick recommended model
* **Pool contains mixed backends**:

  * Some support native edits, some only chat multimodal.
  * Ensure routing considers *logical capability* `imagesEdit` first; protocol selection happens after routing.

### Output edge cases

* **Provider returns a text response instead of an image** (chat path) → `UPSTREAM_INVALID_RESPONSE`
* **Provider returns an image URL that expires immediately**:

  * Prefer saving bytes to a local file (UI can display via local file-serving route) OR return base64 if configured.
* **Output path unsafe** (MCP):

  * absolute path, `..`, outside workspace → `OUTPUT_PATH_INVALID`
* **File collisions**:

  * if `output_path` exists, either fail with `OUTPUT_EXISTS` or suffix automatically (choose consistent rule)

### Response normalization rules

* Always normalize to an internal `ImageResult[]`.
* For HTTP OpenAI endpoints:

  * return `url` when you saved a file and can serve it
  * else return `b64_json`
* For MCP:

  * always return workspace-relative file paths by default

### Error taxonomy (shared)

Use stable codes across UI/MCP/logs:

* `INVALID_INPUT`
* `INVALID_IMAGE_DATA`
* `UNSUPPORTED_IMAGE_FORMAT`
* `IMAGE_TOO_LARGE`
* `IMAGE_FETCH_FAILED`
* `IMAGE_URL_NOT_ALLOWED`
* `MODEL_NOT_CAPABLE`
* `ROUTING_NO_MATCH`
* `UPSTREAM_TIMEOUT`
* `UPSTREAM_ERROR`
* `UPSTREAM_INVALID_RESPONSE`
* `OUTPUT_PATH_INVALID`
* `OUTPUT_WRITE_FAILED`

MCP `{ ok:false }` includes `suggestion` whenever possible.

---

## E) Test matrix (unit / integration / regression)

### Unit tests

**Validation**

* `image_path` rules (workspace-relative, exists, allowed extensions)
* `image_url` rules (scheme, size limit, SSRF blocking)
* mutual exclusivity, required fields

**Resize**

* downsample to `maxPixels` / `maxWidth` / `maxBytes`
* preserve aspect ratio
* verify output format conversion rules
* “no resize” mode

**Routing selection**

* edit requests require `imagesEdit` (logical cap)
* generation requires `imagesGenerate`
* fallback from native images to chat protocol for models with `preferredImageProtocol`

**Normalization**

* native images response (`url`/`b64_json`) → `ImageResult`
* chat multimodal response variants → `ImageResult` (including error cases)

### Integration tests (mock providers)

* Provider A: supports `/images/generations` + `/images/edits`
* Provider B (zimage-like): supports chat multimodal only
* Provider C: supports generations only (no edits)

Scenarios:

* UI generation (no image) routes correctly
* UI edit (multipart image) routes correctly
* MCP edit with `image_path`
* MCP edit with `image_url` (allowed + blocked SSRF cases)
* Verify same prompt + same model yields stable normalized output

### Regression tests

* Existing text-to-image calls:

  * UI `generateImage()` still hits `/v1/images/generations`
  * MCP `generate_image` without image input unchanged
* Snapshot tests for:

  * MCP success payload `{ ok:true, images:[...] }`
  * MCP error payload `{ ok:false, error:{code,...} }`
  * OpenAI endpoint error shape remains consistent

---

## F) Step-by-step implementation order (minimal risk)

### Phase 0 — Prep (no behavior change)

1. **Define shared types**: `ImageTask`, `ImageResult`, `ErrorCode`
2. Add model metadata fields (`imageInputLimits`, logical `imagesEdit` capability) but don’t use them yet.

### Phase 1 — Internal pipeline + MCP support (safe, behind feature flag)

3. Refactor `src/services/imageGeneration.ts` into `ImagePipeline.run(task)`

   * keep existing `runGenerate()` path wired to `/v1/images/generations`
4. Implement **image input loading + validation + resize** in the pipeline
5. Extend `src/mcp/service.ts` `generate_image` tool:

   * accept `image_path|image_url`
   * call `ImagePipeline.run({ kind:"edit"|"generate" })`
   * enforce path safety for output
6. Add unit tests for validation/resize/MCP output contract

> At this point, MCP supports image editing even if UI doesn’t yet.

### Phase 2 — Add `/v1/images/edits` endpoint + adapters

7. Add route/controller for `POST /v1/images/edits` (multipart)
8. Implement adapter selection:

   * If provider adapter supports native edits, use it
   * Else synthesize chat multimodal request (zimage path)
9. Normalize both paths into a single OpenAI `ImagesResponse`

### Phase 3 — UI support (minimal surface change)

10. Update `ui/src/pages/Playground.tsx` and `AgentPlayground.tsx`:

    * add image upload control (drag/drop)
    * show preview + “remove image”
11. Update `ui/src/api/client.ts generateImage()`:

    * if file selected → call `/v1/images/edits` multipart
    * else → `/v1/images/generations` (unchanged)
12. Add UI integration tests (or Playwright smoke tests) for both modes

### Phase 4 — Rollout + observability

13. Feature-flag UI editing (“Enable image input”) for a short period
14. Add telemetry counters:

    * edit vs generate usage
    * native edits vs chat fallback
    * resize triggered rate
    * top error codes
15. Remove flag once stable; keep compatibility indefinitely.



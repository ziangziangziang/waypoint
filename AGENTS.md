# agents.md — OpenAI-Compatible Surface for Agent Workloads (Local Proxy)

This document defines the **minimum OpenAI-compatible API surface** our local reverse proxy should support to run modern “agents” reliably (tool calling, RAG, streaming), plus optional endpoints that are commonly required in production.

---

## 1) Scope

### In scope (v1)
- Provide a **local OpenAI-compatible endpoint** for agent frameworks and SDKs
- Route requests to one of many local backends based on **health + policy**
- Support **streaming (SSE)** correctly
- Support **embeddings** for RAG / memory
- Provide a stable **model mapping** layer (public model names → upstream models)

### Out of scope (v1)
- Full OpenAI platform parity (Assistants/Threads/Runs state machine, fine-tuning, etc.)
- Perfect token counting across all backends (log usage if present; otherwise null)
- Video generation (not standardized across local “OpenAI-compatible” stacks)

---

## 2) What agents typically call

Agent systems commonly rely on:

1) **Chat generation + tool calls**  
   - `POST /v1/chat/completions` (must support `stream: true`)

2) **Embeddings for retrieval (RAG), memory, similarity**
   - `POST /v1/embeddings`

3) **Model discovery / validation**
   - `GET /v1/models`

Optional, depending on product needs:
- Safety gating: `POST /v1/moderations`
- Speech-to-text: `POST /v1/audio/transcriptions`
- Text-to-speech: `POST /v1/audio/speech`
- Images: `POST /v1/images/generations` (and possibly edits/variations)
- Bulk/offline: `POST /v1/batches` (rare for interactive agents)

> Note: “tool calls” are not separate endpoints. They are fields inside chat responses. The agent framework executes tools on the client side and sends results back in a follow-up chat call.

---

## 3) Required endpoints (v1)

### 3.1 `POST /v1/chat/completions`
**Must support**
- Request fields: `model`, `messages`, `stream`, `temperature`, `top_p`, `max_tokens`
- Tool calling pass-through: `tools`, `tool_choice`
- Response shape compatible with OpenAI Chat Completions:
  - Non-stream: `{ id, object, created, model, choices, usage? }`
  - Stream: SSE events `data: {...}\n\n` ending with `data: [DONE]\n\n`

**Streaming correctness requirements**
- No buffering: bytes must flow through as received
- Preserve `Content-Type: text/event-stream`
- Abort upstream when client disconnects (AbortController)

**Error handling expectation**
- If chosen backend fails with retryable error (timeout, connection, TLS, upstream 5xx/429), proxy retries next eligible backend before returning an error.
- Non-retryable errors (400/401/403) return immediately.

---

### 3.2 `POST /v1/embeddings`
**Why agents need this**
- RAG (document retrieval), semantic memory, ranking, clustering.

**Must support**
- Request: `{ model, input }` (input can be string or array)
- Response: `{ data: [{ embedding, index, object }], model, usage? }`

**Notes**
- Many local embedding servers do not return `usage`; log as null.
- Use the same model mapping mechanism as chat.

---

### 3.3 `GET /v1/models`
**Must support**
- Return OpenAI-like list:
  - `{ object: "list", data: [{ id, object: "model", created?, owned_by? }, ...] }`

**Recommended approach**
- Serve **public models** from your Mongo registry (not a raw union of upstream `/v1/models`)
- Each public model maps to (endpoint, upstreamModel) at routing time

---

## 4) Recommended (v1.1+) compatibility shims

### 4.1 `POST /v1/responses` (optional shim)
Some newer SDK flows prefer “Responses API”. If you want maximum client compatibility:
- Provide `/v1/responses` as an alias that internally translates to `/v1/chat/completions` when possible.
- If you don’t implement it, return a clear error:
  - 404 with message: “This proxy supports /v1/chat/completions; /v1/responses not enabled.”

---

## 5) Optional endpoints by capability

### Images (only if agents generate images)
- `POST /v1/images/generations`
- Route to an image backend (Stable Diffusion / Flux / etc.)
- If not supported, return 404 with a clear message.

### Moderations (only if you need safety gating)
- `POST /v1/moderations`
- Can be implemented with:
  - a local moderation model, or
  - a rules engine for internal deployments.

### Audio (if your agents are voice-enabled)
- `POST /v1/audio/transcriptions` (speech → text)
- `POST /v1/audio/speech` (text → speech)

### Files / Batches (rare for agent runtime)
- `POST /v1/files` etc. and `POST /v1/batches`
- Only implement if your chosen agent framework explicitly requires them.

---

## 6) Model mapping (critical for agents)

Agents benefit from stable model names that do not change when backends change.

**Public model** (what the agent asks for): `local-default`, `local-fast`, `embed-default`  
**Upstream model** (what backend expects): `llama-3.1-70b`, `qwen2.5`, `bge-large`

Routing steps:
1) Resolve `publicModel` → candidate endpoints + `upstreamModel`
2) Filter unhealthy endpoints (circuit breaker / downUntil)
3) Choose per policy (Priority or Round Robin)
4) Rewrite request `model` to `upstreamModel`
5) Forward request

---

## 7) Logging expectations for agent workloads

For each request, log:
- requestId, timestamp
- publicModel, chosen endpoint, upstreamModel
- stream vs non-stream
- status code, latency
- error classification (timeout / connection / upstream_5xx / upstream_4xx)
- token usage if provided by backend (`usage.total_tokens`, etc.), else null

Avoid logging full prompts/responses by default (privacy + cost).

---

## 8) Testing checklist (agent-focused)

### Chat completions
- ✅ Non-stream response works for a simple prompt
- ✅ Streaming works with SSE (no buffering)
- ✅ Tool calls pass through (tools/tool_choice) without mutation
- ✅ Client disconnect aborts upstream

### Embeddings
- ✅ Single string input
- ✅ Batch array input
- ✅ Model mapping works

### Routing/failover
- ✅ Backend A down → auto retry Backend B
- ✅ Circuit opens after N failures and recovers after downUntil
- ✅ Health checker updates status and latency EWMA

### Models
- ✅ `GET /v1/models` returns your public model list
- ✅ Unknown model returns clean 400 error

---

## 9) Minimal endpoint set for “agents hosting LLMs”
If you only implement four endpoints, make them:
1) `POST /v1/chat/completions`
2) `POST /v1/embeddings`
3) `GET /v1/models`
4) `POST /v1/images/generations`

Everything else is optional and can be added behind feature flags.

---


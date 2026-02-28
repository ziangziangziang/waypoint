# Using Waypoint with Opencode

Waypoint is a local OpenAI-compatible gateway. Opencode should connect to Waypoint as an external client.

## 1) Start Waypoint

```bash
waypoint provider import -f .env
npm run start
```

Default base URL:

- `http://localhost:8000/v1`

## 2) Point Opencode to Waypoint

Configure Opencode with:

- Base URL: `http://localhost:8000/v1`
- API key: `local-dev` (or your configured auth token)

If Waypoint auth is enabled, send the matching bearer token.

## 3) Validate model discovery

```bash
curl http://localhost:8000/v1/models
```

Waypoint returns an OpenAI-style model list from healthy endpoints and smart pool aliases.
Use `smart` as the default model for free-tier routing with automatic failover.

## 4) Optional: Responses API

Waypoint exposes:

- `POST /v1/responses`

Use this only when your client supports Responses API style requests. Otherwise use chat completions.

## 5) Basic request check

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local-dev" \
  -d '{
    "model": "smart",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

## Troubleshooting

- Empty model list: verify endpoint health with `waypoint status`.
- 401/403: check auth mode and token.
- Slow/failover behavior: inspect `waypoint stats` and dashboard latency panels.

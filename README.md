# Waypoint

Waypoint is a local reverse proxy that exposes OpenAI-compatible endpoints and routes requests across multiple upstream backends with health-based failover.

## Quickstart

```bash
cp .env.example .env
npm install
npm run build
npm run start
```

Docker:

```bash
docker compose up --build
```

## Seed an endpoint

```bash
npm run seed
```

Or use the CLI:

```bash
npm run cli -- add \
  --name local-llm \
  --url http://localhost:11434 \
  --priority 1 \
  --model local-default=llama3 \
  --model embed-default=nomic-embed-text
```

Global CLI (call from anywhere):

```bash
npm run build
npm link
waypoint ls
```

Or install globally from the repo:

```bash
npm install -g .
```

## Endpoints

- `POST /v1/chat/completions`
- `POST /v1/embeddings`
- `GET /v1/models`

Admin (localhost-only if `ADMIN_TOKEN` is unset):

- `GET /admin/endpoints`
- `POST /admin/endpoints`
- `PATCH /admin/endpoints/:id`
- `POST /admin/endpoints/:id/test`
- `GET /admin/health`
- `GET /admin/stats?window=1h`

## CLI commands

- `waypoint ls`
- `waypoint add --name --url --priority [--type llm|diffusion] [--insecureTls] [--apiKey] [--model public=upstream]`
- `waypoint edit` (opens `config.yaml` in `$EDITOR`, default `vim`)
- `waypoint rm <id|name>`
- `waypoint stat`
- `waypoint acct`
- `waypoint test <model>`
- `waypoint service start|stop|restart|status`

## Storage

Waypoint stores config, health, and logs locally:

- `config.yaml` (endpoint config)
- `health.json` (health state)
- `request_logs.jsonl` (request + usage logs)

Default directory: `~/.config/waypoint`

`config.yaml` includes a `type` per endpoint (`llm` or `diffusion`). Defaults to `llm` if omitted.

## Environment

- `PORT=8000`
- `ADMIN_TOKEN` optional bearer token
- `WAYPOINT_DIR` override base storage directory
- `WAYPOINT_CONFIG` override config file path

## Manual test

```bash
BASE_URL=http://localhost:8000 MODEL=local-default npm run manual-test
```

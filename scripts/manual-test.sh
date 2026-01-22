#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${BASE_URL:-http://localhost:8000}
MODEL=${MODEL:-local-default}

curl -sS "$BASE_URL/v1/models" | jq .

curl -sS "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"Hello"}]}' | jq .

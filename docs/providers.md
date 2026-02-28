# Providers and Protocol Adapters

Waypoint uses a provider catalog with protocol adapters.  
External clients still use OpenAI-compatible `/v1/*` endpoints; adapters translate to provider-native protocols.

## Onboarding a non-OpenAI protocol provider

1. Create a provider YAML with:
   - `endpoint.protocol`
   - `endpoint.baseUrl`
   - protocol-specific config (for `inference_v2`: `endpoint.router`)
2. Import with:
   - `waypoint provider import --registry <registry.yaml> --env-file .env`
3. Rebuild pools:
   - `waypoint provider import ...` (default auto rebuild) or `POST /admin/pools/rebuild`
4. Verify:
   - `waypoint provider ls`
   - `waypoint provider show <id>`
   - `waypoint provider model ls <id>`
5. Optional TLS policy:
   - `waypoint provider update <id> --insecure-tls|--strict-tls`
   - `waypoint provider update <id> --auto-insecure-domain <suffix...>`

## Provider model CRUD

Use provider-first model management:

- `waypoint provider model add <providerId> --model-id <id> --upstream <name> --base-url <url>`
- `waypoint provider model update <providerId> <modelRef> ...`
- `waypoint provider model update <providerId> <modelRef> --clear-insecure-tls`
- `waypoint provider model rm <providerId> <modelRef>`
- `waypoint provider model enable <providerId> <modelRef>`
- `waypoint provider model disable <providerId> <modelRef>`
- `waypoint provider model set-key <providerId> <modelRef> --api-key <key>`

Legacy endpoint write commands are blocked in v0.5.0; use migration + provider model commands.

## Inference V2 (ray/kserve-style) example

See: `/Users/zziang/Documents/projects/vibeCoding/Agents/waypoint/examples/providers/inference-v2-ray.yaml`

Key fields:

- `endpoint.protocol: inference_v2`
- `endpoint.router: <router_name>`
- `endpoint.responseTextPaths` (optional response extraction path list)

## Notes

- `inference_v2` v1 supports chat/vision sync (`stream=false`) only.
- Streaming requests are rejected for this protocol unless another pool candidate supports streaming.
- Unknown protocols are imported but marked non-routable.
- Pool alias surface is now a single `smart` alias; legacy `smart-*` aliases are rejected.
- TLS inheritance:
  - Effective TLS mode is `model.insecureTls ?? provider.insecureTls ?? false`.
  - Models added without `--insecure-tls` inherit provider TLS mode.
- Allowlisted auto-insecure fallback:
  - On TLS verify failures, Waypoint retries insecure TLS only when hostname matches provider `autoInsecureTlsDomains`.
  - If retry succeeds, Waypoint persists `model.insecureTls=true` for that model.

## PCAI endpoint migration runbook (`*.ai-application.stjude.org`)

This migration copies endpoint-managed models into provider `pcai`, then disables the source endpoints.

1. Pre-check:
   - `waypoint ls`
2. Run migration:
   - `waypoint provider migrate-endpoints --provider pcai --match-domain ai-application.stjude.org --protocol openai`
3. Verify:
   - `waypoint provider show pcai`
   - `waypoint provider models pcai`
   - `waypoint provider pools`
   - `waypoint ls` (legacy endpoints should show `disabled=yes`)
4. Rollback (single model path):
   - Re-enable the endpoint in `config.yaml` (`disabled: false`) or via admin endpoint patch.
   - Set the corresponding `pcai` provider model `enabled: false` in `$WAYPOINT_DIR/providers.json`.
   - Rebuild pools: `waypoint provider pools` (or `POST /admin/pools/rebuild`).

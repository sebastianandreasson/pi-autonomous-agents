# Request Telemetry Pi Extension

This is a repo-local Pi extension prototype for capturing lower-level request telemetry than `pi-harness` can see on its own.

It writes:

- `pi-output/request-telemetry/requests.jsonl`
- `pi-output/request-telemetry/spans.jsonl`

Optional when debug tracing is enabled:

- `pi-output/request-telemetry/hooks.jsonl`

The goal is to capture exact request boundaries and exact prompt composition before deciding whether we need to patch `pi-mono` itself.

## What It Captures

- one request record per provider request
- exact `context` messages seen before the provider call
- exact prompt spans extracted from the provider payload when available
- context-derived fallback spans when Pi exposes `context` but not the final payload
- tool names and file paths seen through tool hooks
- provider payload summary from `before_provider_request`
- response status and headers from `after_provider_response`
- final assistant-message usage if Pi exposes it on `message.usage`
- `spanSource` on each request so consumers can distinguish:
  - `provider_payload`
  - `context`
  - `session_history`

Default storage is compact:

- `spans.jsonl` keeps attribution metadata and byte counts, not full prompt text
- `hooks.jsonl` is off by default because it is mainly for telemetry debugging

## What It Does Not Claim Yet

- exact per-file token spend
- exact per-span token counts
- exact request usage when the provider does not return usage

Those need either:

- normalized request-usage exposure from Pi/provider adapters
- or tokenizer-backed accounting from the exact serialized payload

## Normal Package Behavior

When `pi-harness` runs through the SDK transport, it now installs a managed shim at:

- `.pi/extensions/pi-harness-request-telemetry/index.mjs`

That makes request telemetry auto-load in consuming repos without needing `--extension`.

Disable that path with:

- `PI_REQUEST_TELEMETRY_ENABLED=0`
- `"piRequestTelemetryEnabled": false` in `pi.config.json`

Enable deeper telemetry capture only when needed:

- `PI_REQUEST_TELEMETRY_STORE_HOOKS=1`
- `"piRequestTelemetryStoreHooks": true`
- `PI_REQUEST_TELEMETRY_STORE_SPAN_TEXT=1`
- `"piRequestTelemetryStoreSpanText": true`

## Running It From This Repo

Use the extension file directly:

```bash
pi --extension ./pi-extensions/request-telemetry/index.mjs
```

Or copy or symlink it into a Pi extension directory:

- project-local: `./.pi/extensions/`
- global: `~/.pi/agent/extensions/`

If you move only `index.mjs`, it will break because it currently imports helpers from this repo at `src/pi-request-telemetry.mjs`. Keep the repo checkout intact for this prototype.

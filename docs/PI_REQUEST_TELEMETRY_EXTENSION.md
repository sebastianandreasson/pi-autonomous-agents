# Pi Request Telemetry Extension

This document describes the repo-local Pi extension prototype under [pi-extensions/request-telemetry](../pi-extensions/request-telemetry/README.md).

In normal `pi-harness` SDK runs, this extension is auto-enabled by installing a managed shim under `.pi/extensions/pi-harness-request-telemetry/` in the consuming repo before Pi reloads resources. Opt out with `PI_REQUEST_TELEMETRY_ENABLED=0` or `"piRequestTelemetryEnabled": false`.

The purpose of this extension is to gather request-level data directly from Pi extension hooks before we decide whether to patch `@mariozechner/pi-coding-agent` or `pi-ai`.

## Produced Artifacts

- `pi-output/request-telemetry/hooks.jsonl`
- `pi-output/request-telemetry/requests.jsonl`
- `pi-output/request-telemetry/spans.jsonl`

These artifacts are intentionally separate from the existing `pi-output/token-usage/*` files.

`token-usage` remains the harness-level normalized output.
`request-telemetry` is the lower-level Pi-extension probe for real request boundaries and prompt composition.

## Hook Coverage

The extension listens to:

- `session_start`
- `session_switch`
- `model_select`
- `turn_start`
- `context`
- `before_provider_request`
- `after_provider_response`
- `tool_execution_start`
- `tool_result`
- `message_end`
- `turn_end`

The documented hooks come from Pi’s extension API:

- [Extension Hooks](https://pt-act-pi-mono.mintlify.app/api/coding-agent/hooks)
- [Extension System](https://pt-act-pi-mono.mintlify.app/concepts/extensions)

The current source also exposes undocumented provider-boundary hooks:

- `before_provider_request`
- `after_provider_response`

Source:

- [packages/coding-agent/src/core/extensions/types.ts](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts)

## Request Artifact Schema

Each row in `requests.jsonl` contains one provider request finalized by the following assistant `message_end`:

- `schemaVersion`
- `timestamp`
- `requestId`
- `sessionId`
- `turnIndex`
- `startedAt`
- `finishedAt`
- `durationMs`
- `statusCode`
- `provider`
- `model`
- `api`
- `stopReason`
- `usageSource`
- `source`
- `spanSource`
- `contextMessageCount`
- `spanCount`
- `textChars`
- `textBytes`
- `toolNames`
- `files`
- `providerPayloadSummary`
- `responseHeaders`
- `inputTokens`
- `outputTokens`
- `totalTokens`
- `cacheReadTokens`
- `cacheWriteTokens`

`usageSource` is one of:

- `message_usage`
- `unavailable`

This is intentionally conservative. The extension does not invent totals when the provider does not expose them.

`spanSource` describes where the prompt-span reconstruction came from:

- `provider_payload`
- `context`
- `session_history`

Interpretation:

- `provider_payload` is the strongest source because it comes from the final request payload.
- `context` is also exact for the pre-request message set Pi exposed to the extension.
- `session_history` is a fallback when Pi omits both `context` and provider payload hooks for a given assistant response.

`hooks.jsonl` is a lifecycle trace of:

- `turn_start`
- `context`
- `before_provider_request`
- `after_provider_response`
- `message_end`
- `turn_end`

Use it to debug request association problems or confirm whether Pi emitted provider-boundary hooks for a specific run.

## Span Artifact Schema

Each row in `spans.jsonl` contains one extracted prompt span:

- `schemaVersion`
- `timestamp`
- `requestId`
- `sessionId`
- `turnIndex`
- `source`
- `role`
- `messageIndex`
- `spanIndex`
- `spanKind`
- `toolCallId`
- `toolName`
- `paths`
- `primaryPath`
- `charCount`
- `byteCount`
- `text`
- `preview`

Current `spanKind` values include:

- `text`
- `thinking`
- `tool_call`
- `tool_result`
- `image`
- `unknown`

## Exact vs Inferred

This extension is meant to move the data model closer to real accounting.

Exact today:

- provider request boundaries when `before_provider_request` fires
- pre-request context messages
- provider-payload-derived spans when Pi exposes the final payload
- provider payload summary
- tool/file context seen by extension hooks
- final request totals when `message.usage` is present

Not exact today:

- token counts for each prompt span
- per-file token billing
- request totals when the backend omits usage entirely
- `session_history` span reconstructions when neither `context` nor provider payload is exposed

That means these artifacts are suitable for:

- validating whether Pi/provider already exposes exact request usage
- seeing the true prompt composition for each provider request
- building tokenizer-backed attribution later from exact captured spans

They are not yet a replacement for exact per-file cost accounting.

## Recommended Next Step

Use this extension first to answer two questions:

1. Does your backend populate `message.usage` consistently?
2. Does `before_provider_request` give enough final payload detail to tokenize exact prompt spans?

If both answers are yes, the next step is tokenizer-backed per-span accounting.
If usage is still missing, the right fix is likely upstream in `pi-ai` or `pi-coding-agent`, not more harness-side heuristics.

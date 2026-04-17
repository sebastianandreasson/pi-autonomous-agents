# Token Usage Artifacts

This document is written for autonomous coding agents and repo maintainers who want to use the token-usage artifacts produced by `pi-harness` in their own projects.

The goal is not just to visualize token usage. The goal is to expose a stable machine-readable contract that other tools, prompts, reports, or project-specific scripts can reuse.

## Produced Artifacts

Repo-scoped artifacts:

- `pi-output/token-usage/events.jsonl`
- `pi-output/token-usage/summary.json`

Run-scoped artifacts:

- `.pi-runtime/runs/<runId>/token-usage.events.jsonl`
- `.pi-runtime/runs/<runId>/token-usage.summary.json`

Use repo-scoped files when you want the latest cumulative view for the repository.
Use run-scoped files when you want to inspect one specific harness run in isolation.

## Recommended Consumption Order

When an agent wants to use token data, prefer this order:

1. Read `token-usage.summary.json` first.
2. Only read `token-usage.events.jsonl` if the summary is not enough.
3. Prefer run-scoped artifacts when analyzing one run.
4. Prefer repo-scoped artifacts when looking for long-term hotspots.

This keeps token-analysis prompts compact and avoids spending more tokens just to inspect token data.

## Event Schema

Each line in `events.jsonl` is one normalized token-attribution event.

Important fields:

- `schemaVersion`
- `timestamp`
- `runId`
- `transport`
- `sessionId`
- `model`
- `iteration`
- `retryCount`
- `reason`
- `phase`
- `role`
- `kind`
- `attributionKind`
- `toolNames`
- `files`
- `primaryFile`
- `inputTokens`
- `outputTokens`
- `totalTokens`
- `cacheReadTokens`
- `cacheWriteTokens`

Semantics:

- `kind`, `phase`, and `role` identify the harness stage where the tokens were spent.
- `toolNames` and `files` capture the nearby tool/file context seen around the token event.
- `attributionKind` explains how the event was classified:
  - `thinking`
  - `response`
  - `tool_context`
  - `tool_running`
  - `agent`

Important:

- file and directory attribution are inferred from nearby tool context
- they are useful for hotspot detection, not exact provider-native accounting
- if one token event touches multiple files, downstream summaries may split that event across those files

## Summary Schema

`summary.json` contains:

- `schemaVersion`
- `generatedAt`
- `source.eventCount`
- `totals`
- `coverage`
- `breakdowns`

`totals` contains:

- `inputTokens`
- `outputTokens`
- `totalTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `eventCount`

`coverage` contains:

- `fileAttributedTokens`
- `unattributedTokens`
- `fileAttributionRatio`

`breakdowns` contains:

- `byKind`
- `byRole`
- `byPhase`
- `byModel`
- `bySession`
- `byAttribution`
- `byTool`
- `byFile`
- `byDirectory`

Each breakdown item contains:

- `key`
- `label`
- `inputTokens`
- `outputTokens`
- `totalTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `eventCount`

## How Agents Should Use This Data

Use token artifacts to answer questions like:

- Which harness phases are spending the most tokens?
- Which files or directories repeatedly consume tokens?
- Are retries concentrated in one hotspot?
- Is token usage dominated by thinking, tool-context, or response generation?
- Are certain models or sessions much more expensive than others?

Good uses:

- splitting a large TODO item into narrower tasks
- identifying files that should be decomposed before another agent pass
- deciding whether a hot directory needs refactor work
- comparing whether `developer` or `tester` is driving most cost
- checking whether a local model is wasting tokens on repeated tool/file churn

Bad uses:

- treating `byFile` values as exact per-file billing
- assuming all unattributed tokens are waste
- optimizing for raw token count while ignoring correctness

## Agent Workflow Guidance

When an agent is asked to improve harness efficiency in a repo:

1. Read `summary.json`.
2. Inspect `breakdowns.byFile`, `breakdowns.byDirectory`, `breakdowns.byTool`, and `breakdowns.byAttribution`.
3. If one file or directory dominates, inspect the related source only after confirming the hotspot from the summary.
4. If `fileAttributionRatio` is low, rely more on `byKind`, `byRole`, `byModel`, and `byAttribution` than on `byFile`.
5. When proposing changes, explicitly distinguish:
   - exact token totals from artifacts
   - inferred file attribution from nearby context

## Recommended Interpretation Rules

Use these heuristics:

- High `byFile` and high `fileAttributionRatio`:
  Strong signal that the file is a real hotspot.
- High `byDirectory` with spread across many files:
  The problem is probably architectural or task-shaping, not one file only.
- High `byAttribution.tool_context` or `tool_running`:
  The agent may be rereading, diffing, or patching inefficiently.
- High `byAttribution.thinking` with low file coverage:
  The problem may be task ambiguity or prompt shape rather than one code hotspot.
- High `byModel` on one role:
  That role may need a smaller scope, different model, or clearer repo instructions.

## Instruction Snippet For Consuming Repos

If a consuming repo wants its own agents to use the artifacts, add guidance like this to repo-local instructions:

```md
## Token Usage Data

This repo may contain `pi-harness` token artifacts:

- `pi-output/token-usage/summary.json`
- `pi-output/token-usage/events.jsonl`

When investigating repeated retries, large agent turns, or code hotspots:

1. Read `summary.json` first.
2. Use `breakdowns.byFile`, `breakdowns.byDirectory`, `breakdowns.byTool`, and `breakdowns.byAttribution` to locate hotspots.
3. Treat file and directory token attribution as inferred context, not exact billing.
4. If one file is a clear hotspot, prefer smaller TODOs, narrower reads, or structural refactors over brute-force retries.
5. If file attribution is weak, rely more on `byKind`, `byRole`, `byModel`, and `byAttribution`.
```

## Project-Specific Extensions

Projects can build their own tooling on top of these artifacts, for example:

- nightly regression reports that flag rising token hotspots
- CI checks that warn when one file dominates token spend
- repo-specific dashboards
- prompt builders that mention known hotspots before starting a developer turn
- scripts that compare token patterns before and after a refactor

When doing that, depend on:

- `schemaVersion`
- the named summary fields
- the normalized event fields

Do not depend on the visualizer UI structure or CSS. Those are consumers, not the contract.

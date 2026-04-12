# PI Harness

`pi-harness` is a portable CLI/workflow package for running a local PI-based unattended loop with:

- a `developer` pass
- a fast verification step
- a skeptical `tester` pass
- optional periodic multimodal visual review
- tester-owned final commit by default

The package is intentionally generic. It does not know how to navigate or test a specific app on its own.

## What Belongs In The Package

- supervisor/orchestration
- PI adapter/runtime integration
- config loading
- telemetry
- loop guards, timeout guards, and retries
- tester feedback + visual feedback handoff
- optional legacy harness git finalize step for `commitMode: "plan"`
- multimodal visual review client

## What Stays Per Project

- `TODOS.md`
- project instructions
- browser tests
- visual capture flow
- app-specific verification commands
- app/server startup scripts

## Layout

```text
packages/pi-harness/
  package.json
  pi.config.json
  templates/DEVELOPER.md
  templates/TESTER.md
  docs/PI_SUPERVISOR.md
  src/
    cli.mjs
    pi-client.mjs
    pi-config.mjs
    pi-prompts.mjs
    pi-repo.mjs
    pi-report.mjs
    pi-rpc-adapter.mjs
    pi-supervisor.mjs
    pi-telemetry.mjs
    pi-visual-once.mjs
    pi-visual-review.mjs
```

## CLI

```bash
pi-harness once
pi-harness run
pi-harness report
pi-harness clear-history
pi-harness visual-once
pi-harness adapter
pi-harness visual-review-worker
```

Use `PI_CONFIG_FILE` to point the harness at a project-local config file. If you do not provide one, the bundled generic `pi.config.json` is used as a fallback.

## Setup In Another Repo

After installing the package:

```bash
npm install -D @sebastianandreasson/pi-autonomous-agents
```

you can tell another agent in that repo:

```text
Find SETUP.md in @sebastianandreasson/pi-autonomous-agents and set everything up for this repository.
```

The package ships a top-level [SETUP.md](./SETUP.md) specifically for that workflow.

If you want to wipe all harness-generated state and start over cleanly in a repo, run:

```bash
PI_CONFIG_FILE=pi.config.json pi-harness clear-history
```

The command removes configured harness history/runtime files and verifies that no configured history paths remain afterward.

For prompt debugging, the harness also writes the exact assembled prompt for the current role to `.pi-last-prompt.txt` by default.
For flow debugging, it also writes a machine-readable `.pi-last-iteration.json` summary with the selected task, tester verdict, commit-plan state, and terminal reason.

## Generic Contracts

- `taskFile`: usually `TODOS.md`
- `developerInstructionsFile`: per-project developer instructions
- `testerInstructionsFile`: per-project tester instructions
- `roleModels`: optional per-role model overrides
- `commitMode`: `agent` by default, `plan` only for legacy harness-managed commit parsing
- `promptMode`: `compact` by default
- `testCommand`: fast verification command
- `visualCaptureCommand`: project-defined screenshot capture command
- `visualFeedbackFile`: latest visual-review handoff
- `testerFeedbackFile`: latest tester-review handoff

For unattended loops, keep `testCommand` fast and bounded, such as a smoke suite. Long real-time Playwright happy-path specs belong in an explicit nightly or post-run lane, not the default developer/tester inner loop.

Keep TODO items extremely small and implementation-shaped when using weaker local models. Broad tasks tend to produce much longer turns, more retries, and more tester drift than narrow one-step tasks.

The adapter heartbeat is PI-RPC-event based. Streaming shell output does not count as progress on its own, so long-running tools should rely on the tool-aware watchdog thresholds rather than terminal streaming.

`piModel` remains the default text model, but you can override specific roles with `roleModels` such as `developer`, `developerRetry`, `developerFix`, `tester`, and `visualReview`. `testerCommit` is only relevant if you opt back into `commitMode: "plan"`.

By default, successful tester passes should stage and create the commit directly in the same PI turn. The old commit-plan parsing flow is still available as `commitMode: "plan"`, but it is now a compatibility mode rather than the default.

Prompt/context handoff is compact by default. The harness now caps prior feedback excerpts, changed-file lists, verification excerpts, and prompt note handoff. If needed, tune `maxPromptChangedFiles`, `maxVisualFeedbackLines`, `maxTesterFeedbackLines`, `maxPromptNotesLines`, and `maxVerificationExcerptLines`.

The default coding tool mix is now safer for local models: `read,edit,write,find,ls,bash`. Prompts explicitly steer source inspection toward `read` and reserve shell usage for `git`, tests, and narrow diagnostics.

The harness also emits lightweight large-file warnings for touched source/spec files and carries them into `.pi-last-iteration.json`, `pi-harness report`, and relevant prompts. Tune `largeFileWarningLines` and `largeSpecWarningLines` if needed.

The harness expects screenshot capture to produce a `manifest.json` plus image files under the configured visual capture directory.

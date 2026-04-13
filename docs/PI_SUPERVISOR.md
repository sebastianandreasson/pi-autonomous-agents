# PI Harness Supervisor

`pi-harness` provides a bounded unattended-work supervisor for TODO-driven local-agent loops.

The package is generic. It orchestrates the loop, but each consuming repo defines its own:

- `TODOS.md`
- project instructions
- verification command
- visual capture flow
- model/backend configuration

## Core Flow

Each real iteration follows this sequence:

1. `developer` implements one coherent task from `TODOS.md`.
2. A fast local verification command runs immediately after the developer round.
3. If verification passes, `tester` reviews the change independently from a skeptical user-facing perspective.
4. If tester or verification finds a real issue, the supervisor gives the findings back to `developer` for one focused repair pass.
5. If tester reaches `PASS`, tester creates the commit directly in the same turn by default.
6. Optionally, every `N` successful iterations, the harness runs a read-only visual review over screenshots and persists the feedback for later runs.
7. If that visual review returns `FAIL`, `BLOCKED`, or times out, the iteration is not counted as a success and the feedback is carried into later prompts.

## Package Contents

Main package files:

- `src/pi-supervisor.mjs`: controller
- `src/pi-client.mjs`: transport layer
- `src/pi-sdk-turn.mjs`: in-process PI SDK turn runner for `transport: "sdk"`
- `src/pi-config.mjs`: config loader
- `src/pi-repo.mjs`: repo helpers, verification runner, and git finalize helpers
- `src/pi-telemetry.mjs`: telemetry writer/reader
- `src/pi-prompts.mjs`: default prompt builders
- `src/pi-visual-review.mjs`: multimodal visual-review worker
- `src/pi-visual-once.mjs`: one-shot manual visual review runner
- `src/pi-visualizer.mjs`: local web UI for orchestration flow and active stage
- `src/pi-visualizer-shared.mjs`: flow-state helpers for visualizer
- `src/pi-report.mjs`: telemetry summary report
- `templates/DEVELOPER.md`: default developer-role instructions template
- `templates/TESTER.md`: default tester-role instructions template

## CLI

```bash
pi-harness once
pi-harness run
pi-harness report
pi-harness visual-once
pi-harness visualize
```

The package reads `PI_CONFIG_FILE` if provided. Otherwise it falls back to the bundled generic `pi.config.json`.

`pi-harness run` also starts SSE-backed web UI over local HTTP by default. Defaults: `PI_VISUALIZER_HOST=127.0.0.1`, `PI_VISUALIZER_PORT=4317`. Set `PI_VISUALIZER=0` to disable it for a run.

`pi-harness visualize` remains available as standalone viewer.

Visualizer reads active-run lock, TODO file, per-run state, per-run iteration summary, per-run last output snapshot, live feed JSONL, and telemetry to show current stage plus historical runs.

## Config Contract

Projects typically provide their own `pi.config.json` with fields such as:

- `taskFile`
- `developerInstructionsFile`
- `testerInstructionsFile`
- `roleModels`
- `testCommand`
- `continueAfterSeconds`
- `toolContinueAfterSeconds`
- `noEventTimeoutSeconds`
- `toolNoEventTimeoutSeconds`
- `visualCaptureCommand`
- `visualFeedbackFile`
- `testerFeedbackFile`
- `models`
- `piModel`
- `visualReviewModel`
- `commitMode`

Model entries may carry their own OpenAI-compatible endpoint settings, so the PI text loop and the multimodal visual reviewer can point at different backends without changing code.

`piModel` is the default text model. Projects can optionally override specific roles through `roleModels`, for example:

```json
{
  "piModel": "local/dev-model",
  "visualReviewModel": "cloud/vision-model",
  "roleModels": {
    "developer": "local/dev-model",
    "developerRetry": "local/dev-model",
    "developerFix": "local/dev-model",
    "tester": "local/tester-model",
    "visualReview": "cloud/vision-model"
  }
}
```

This lets the main developer/tester loop stay on local models while a stronger frontier model is reserved for periodic review roles.

For unattended inner-loop work, `testCommand` should be a bounded smoke gate rather than a long real-time end-to-end happy-path run. Reserve full-flow Playwright journeys for explicit nightly or post-run lanes.

## Transport Contract

The supervisor supports:

- `PI_TRANSPORT=mock`
- `PI_TRANSPORT=sdk` (default)

`sdk` runs PI in-process via Node SDK. `mock` preserves harness flow but skips real agent work.

## Git Finalization

The default flow keeps commit ownership with the active agent:

1. `developer` should leave a clean, reviewable diff and should not commit.
2. `tester` should review functionality and, on `PASS`, stage only the task-related files and create the commit directly.
3. If the working tree is too messy to isolate safely, tester should return `VERDICT: BLOCKED` instead of guessing.

If a repo explicitly needs the older harness-managed commit-plan flow, set `commitMode` to `plan`. In that mode, `testerCommit` and parsed commit plans are used as a compatibility path rather than the default.

For source inspection, prompts prefer `read` and reserve shell usage for `git`, tests, and narrow diagnostics. Large shell file reads are more likely to truncate under context pressure than focused `read` calls.

## Persistent Handoffs

The harness persists two cross-iteration handoff files:

- visual review feedback:
  - `pi-output/visual-review/FEEDBACK.md`
- tester feedback:
  - `pi-output/tester-feedback/FEEDBACK.md`

These files are included in later developer/tester prompts, so new runs start with the latest review context.

Commit-plan follow-up passes still write history entries, but they do not replace the latest substantive tester feedback file. That keeps later developer turns grounded in the last real functional review rather than commit bookkeeping.

## Visual Capture Contract

The visual-review layer is intentionally generic. The harness does not know how to navigate a specific project.

Instead, when `PI_VISUAL_CAPTURE_CMD` is configured, it runs that command with:

- `PI_VISUAL_ITERATION`
- `PI_VISUAL_PHASE`
- `PI_VISUAL_CAPTURE_DIR`
- `PI_VISUAL_MANIFEST_FILE`
- `PI_VISUAL_CHANGED_FILES`

The capture command must write a JSON manifest at `PI_VISUAL_MANIFEST_FILE` with this shape:

```json
{
  "screens": [
    {
      "id": "main_menu",
      "label": "Main menu",
      "path": "main-menu.png"
    }
  ]
}
```

`path` is resolved relative to `PI_VISUAL_CAPTURE_DIR`. The harness validates that each referenced image exists before calling the multimodal visual reviewer.

## Loop Mitigation

SDK transport mitigates obvious local loops by watching agent and tool events:

- repeated identical tool calls are aborted
- repeated same-path churn is aborted
- a soft `continue` can be sent after inactivity
- a separate tool-aware watchdog can tolerate long-running `bash` or browser work without treating the turn as dead
- a hard no-event timeout aborts a wedged turn instead of hanging indefinitely
- parent-loss shutdown tears down owned supervisor child work instead of allowing orphaned background runs

Important: terminal streaming does not reset the heartbeat by itself. The watchdog keys off SDK agent events and active tool state, not raw shell output.

## Telemetry

Each step records:

- timestamp
- iteration
- phase
- kind
- status
- transport
- session id
- timeout flag
- exit code
- duration
- commit before and after
- changed file count
- verification status
- retry count
- notes

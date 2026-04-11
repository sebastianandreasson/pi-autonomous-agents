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
5. If tester reaches `PASS`, tester provides a commit plan and the harness performs the actual git finalization.
6. Optionally, every `N` successful iterations, the harness runs a read-only visual review over screenshots and persists the feedback for later runs.

## Package Contents

Main package files:

- `src/pi-supervisor.mjs`: controller
- `src/pi-client.mjs`: transport layer
- `src/pi-rpc-adapter.mjs`: built-in adapter from supervisor JSON to `pi --mode rpc`
- `src/pi-config.mjs`: config loader
- `src/pi-repo.mjs`: repo helpers, verification runner, git finalize step
- `src/pi-telemetry.mjs`: telemetry writer/reader
- `src/pi-prompts.mjs`: default prompt builders
- `src/pi-visual-review.mjs`: multimodal visual-review worker
- `src/pi-visual-once.mjs`: one-shot manual visual review runner
- `src/pi-report.mjs`: telemetry summary report
- `templates/DEVELOPER.md`: default developer-role instructions template
- `templates/TESTER.md`: default tester-role instructions template

## CLI

```bash
pi-harness once
pi-harness run
pi-harness report
pi-harness visual-once
```

The package reads `PI_CONFIG_FILE` if provided. Otherwise it falls back to the bundled generic `pi.config.json`.

## Config Contract

Projects typically provide their own `pi.config.json` with fields such as:

- `taskFile`
- `developerInstructionsFile`
- `testerInstructionsFile`
- `testCommand`
- `visualCaptureCommand`
- `visualFeedbackFile`
- `testerFeedbackFile`
- `models`
- `piModel`
- `visualReviewModel`

Model entries may carry their own OpenAI-compatible endpoint settings, so the PI text loop and the multimodal visual reviewer can point at different backends without changing code.

## Transport Contract

The supervisor supports:

- `PI_TRANSPORT=mock`
- `PI_TRANSPORT=adapter`

The built-in adapter command is typically:

```bash
pi-harness adapter
```

When using `adapter`, set `PI_ADAPTER_COMMAND` to a command that:

1. Reads one JSON request from `stdin`
2. Talks to PI RPC or your own PI wrapper
3. Writes one JSON response to `stdout`
4. Exits with code `0` on success

Request shape:

```json
{
  "sessionId": "existing-or-empty",
  "sessionFile": "/absolute/path/to/session.jsonl",
  "prompt": "controller prompt",
  "cwd": "/absolute/repo/path",
  "taskFile": "/absolute/repo/path/TODOS.md",
  "instructionsFile": "/absolute/repo/path/pi/DEVELOPER.md",
  "runtimeDir": "/absolute/repo/path/.pi-runtime",
  "piCli": "pi",
  "model": "local/model-name",
  "tools": "read,bash,edit,write,grep,find,ls",
  "thinking": "",
  "noExtensions": false,
  "noSkills": false,
  "noPromptTemplates": false,
  "noThemes": true,
  "metadata": {
    "iteration": 1,
    "retryCount": 0,
    "reason": "main_workflow"
  }
}
```

Response shape:

```json
{
  "sessionId": "stable-session-id",
  "sessionFile": "/absolute/path/to/session.jsonl",
  "status": "success",
  "output": "agent output text",
  "notes": "short controller note"
}
```

Allowed response `status` values:

- `success`
- `stalled`
- `timed_out`
- `failed`
- `canceled`

## Git Finalization

The harness is designed to keep commit history structured:

1. `developer` should leave a clean, reviewable diff and should not commit.
2. `tester` should review functionality and, on `PASS`, provide a commit plan:
   - `COMMIT_MESSAGE: ...`
   - `COMMIT_FILES:`
   - `- path/to/file`
3. The harness stages only those requested files and performs the commit itself.
4. If the requested plan cannot be isolated safely, the iteration is blocked or failed instead of committing unrelated work.

## Persistent Handoffs

The harness persists two cross-iteration handoff files:

- visual review feedback:
  - `pi-output/visual-review/FEEDBACK.md`
- tester feedback:
  - `pi-output/tester-feedback/FEEDBACK.md`

These files are included in later developer/tester prompts, so new runs start with the latest review context.

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

The built-in adapter mitigates obvious local loops by watching PI RPC tool events:

- repeated identical tool calls are aborted
- repeated same-path churn is aborted
- a soft `continue` can be sent after inactivity
- a hard no-event timeout aborts a wedged turn instead of hanging indefinitely

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

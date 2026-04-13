# PI Autonomous Agents

`@sebastianandreasson/pi-autonomous-agents` is an npm package for running a bounded unattended [PI](https://pi.dev/) workflow inside another repository.

It orchestrates:

- a `developer` turn
- a fast local verification step
- an independent `tester` turn
- an optional focused `developerFix` turn when verification/tester finds a real issue
- optional periodic visual review from screenshots

The package is intentionally generic. It handles supervision, prompts, runtime state, telemetry, retries, and guardrails. The consuming repo still owns its own tasks, instructions, tests, model endpoints, and screenshot capture flow.

## Install

```bash
npm install -D @sebastianandreasson/pi-autonomous-agents
```

Then in the consuming repo, tell your agent:

```text
Find SETUP.md in @sebastianandreasson/pi-autonomous-agents and set everything up for this repository.
```

The package ships a top-level [SETUP.md](./SETUP.md) specifically for that workflow.

## What This Package Owns

- unattended loop orchestration
- PI adapter integration
- config loading
- prompt assembly
- verification/tester/visual-review handoff
- timeout and loop guards
- telemetry and run summaries
- runtime isolation and stale-run recovery

## What Each Repo Must Provide

- `TODOS.md`
- repo-specific `pi/DEVELOPER.md`
- repo-specific `pi/TESTER.md`
- a fast bounded `testCommand`
- model configuration that actually matches the local/cloud providers in use
- optionally a screenshot capture command for visual review

## Quick Start In A Repo

The normal setup shape is:

```text
TODOS.md
pi.config.json
pi/
  DEVELOPER.md
  TESTER.md
```

Typical scripts:

```json
{
  "scripts": {
    "pi:mock": "PI_CONFIG_FILE=pi.config.json PI_TRANSPORT=mock PI_TEST_CMD= pi-harness once",
    "pi:once": "PI_CONFIG_FILE=pi.config.json pi-harness once",
    "pi:run": "PI_CONFIG_FILE=pi.config.json pi-harness run",
    "pi:report": "PI_CONFIG_FILE=pi.config.json pi-harness report",
    "pi:visual:once": "PI_CONFIG_FILE=pi.config.json pi-harness visual-once"
  }
}
```

Start from [templates/pi.config.example.json](./templates/pi.config.example.json), [templates/DEVELOPER.md](./templates/DEVELOPER.md), [templates/TESTER.md](./templates/TESTER.md), and [templates/gitignore.fragment](./templates/gitignore.fragment).

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

Use `PI_CONFIG_FILE` to point at the repo-local config file:

```bash
PI_CONFIG_FILE=pi.config.json pi-harness once
```

If `PI_CONFIG_FILE` is not set, the package falls back to the bundled generic [pi.config.json](./pi.config.json).

## Core Workflow

Each real iteration works like this:

1. `developer` implements one unchecked task from `TODOS.md`.
2. The harness runs the configured fast verification command.
3. If verification passes, `tester` reviews the change independently.
4. If tester or verification fails, the findings go back to `developerFix` for one focused repair pass.
5. If tester reaches `PASS`, tester creates the final commit directly by default.
6. Every `N` successful iterations, optional visual review can inspect screenshots and veto the success if it finds a real problem.

The default commit model is `commitMode: "agent"`. The older harness-managed parsed commit-plan flow still exists as `commitMode: "plan"`, but it is now a compatibility mode rather than the default.

## Recommended Model Setup

The package supports:

- one default text model via `piModel`
- one default visual-review model via `visualReviewModel`
- optional per-role overrides via `roleModels`
- per-model endpoint config in `models`

Typical pattern:

- local model for `developer`
- local model for `developerRetry`
- local model for `developerFix`
- local or slightly stronger model for `tester`
- stronger frontier model only for `visualReview`

Example:

```json
{
  "piModel": "local/text-model",
  "visualReviewModel": "cloud/vision-model",
  "models": {
    "local/text-model": {
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "local",
      "vision": false
    },
    "local/tester-model": {
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "local",
      "vision": false
    },
    "cloud/vision-model": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "vision": true
    }
  },
  "roleModels": {
    "developer": "local/text-model",
    "developerRetry": "local/text-model",
    "developerFix": "local/text-model",
    "tester": "local/tester-model",
    "visualReview": "cloud/vision-model"
  }
}
```

Important:

- do not guess model ids
- if using a custom OpenAI-compatible provider, verify `<baseUrl>/models`
- if using PI models directly, verify `pi --list-models`
- if `PI_CODING_AGENT_DIR` points at a repo-local PI home, make sure it is bootstrapped and contains `models.json`

The harness now preflights those checks before starting a real run.

## Important Config Fields

Common fields in `pi.config.json`:

- `taskFile`
- `developerInstructionsFile`
- `testerInstructionsFile`
- `transport`
- `adapterCommand`
- `piModel`
- `models`
- `roleModels`
- `commitMode`
- `promptMode`
- `testCommand`
- `visualReviewEnabled`
- `visualCaptureCommand`
- `continueAfterSeconds`
- `toolContinueAfterSeconds`
- `noEventTimeoutSeconds`
- `toolNoEventTimeoutSeconds`
- `largeFileWarningLines`
- `largeSpecWarningLines`

Key defaults:

- `transport`: `adapter`
- `commitMode`: `agent`
- `promptMode`: `compact`
- `piTools`: `read,edit,write,find,ls,bash`
- `continueAfterSeconds`: `300`
- `toolContinueAfterSeconds`: `900`
- `noEventTimeoutSeconds`: `900`
- `toolNoEventTimeoutSeconds`: `1800`

## Prompt and Tooling Behavior

The package is optimized for local models by default:

- prompts are compacted before handoff
- changed-file lists and feedback excerpts are capped
- prompts prefer `read` for source inspection
- shell is intended for `git`, tests, and narrow diagnostics
- the adapter warns on obvious oversized shell-based file reads
- the supervisor emits large-file/spec warnings when touched files are getting risky

This is deliberate. Large monolith files, huge e2e specs, and broad TODO items are one of the main causes of local-model drift and retry loops.

Recommended repo shape:

- keep TODO items very small and implementation-shaped
- split giant stores/modules before they become constant edit hotspots
- split ever-growing end-to-end specs into scenario files
- keep the default `testCommand` to a bounded smoke check, not a multi-minute happy-path run

## Runtime Isolation And Recovery

Recent versions of the package isolate each run more aggressively:

- active ownership lock at `.pi-runtime/active-run.json`
- per-run runtime directory under `.pi-runtime/runs/<runId>/`
- per-run PI sessions and telemetry
- `runId` added to telemetry
- in-progress iteration state persisted before agent work starts
- stale run locks recovered when the owning PID is gone
- timeout cleanup kills the full spawned process group, not only the direct child

That is meant to prevent orphaned timed-out agents or concurrent supervisors from corrupting shared state.

## Debugging Artifacts

Useful files during a run:

- `.pi-last-prompt.txt`
  Exact assembled prompt for the current role.
- `.pi-last-output.txt`
  Latest agent output snapshot.
- `.pi-last-verification.txt`
  Latest verification output snapshot.
- `.pi-last-iteration.json`
  Structured summary of the last completed iteration.
- `.pi-state.json`
  Persistent harness state, including in-progress iteration data.
- `pi.log`
  Main run log.
- `pi_telemetry.jsonl`
- `pi_telemetry.csv`
- `.pi-runtime/active-run.json`
- `.pi-runtime/runs/<runId>/...`

`pi-harness report` summarizes recent telemetry and surfaces things like terminal reasons and large-file warnings.

## Visual Review Contract

Visual review is optional and generic. The harness does not know how to navigate your app.

If enabled, your repo must provide a real screenshot capture command that writes a manifest under the configured capture directory. The manifest shape is documented in [docs/PI_SUPERVISOR.md](./docs/PI_SUPERVISOR.md).

Visual review should be used as a periodic audit, not as the default inner-loop gate.

## Resetting Harness State

If you want to wipe harness-generated state and start fresh:

```bash
PI_CONFIG_FILE=pi.config.json pi-harness clear-history
```

That clears configured harness runtime/history artifacts and verifies they are gone. It does not remove project source files.

## Docs

- [SETUP.md](./SETUP.md)
  Agent-facing setup instructions for consuming repos.
- [docs/PI_SUPERVISOR.md](./docs/PI_SUPERVISOR.md)
  More detailed flow, adapter, and runtime documentation.
- [templates/PROJECT_SETUP.md](./templates/PROJECT_SETUP.md)
  Minimal consuming-repo layout summary.

## Development

In this package repo:

```bash
npm run check
npm test
```

The package requires Node `>=20`.

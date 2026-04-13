# Setup Guide

This file is written for an autonomous coding agent that has been asked to set up `@sebastianandreasson/pi-autonomous-agents` in the current repository.

## Goal

Install and configure the package so this repo can run:

- `pi-harness once`
- `pi-harness run`
- `pi-harness report`
- `pi-harness visual-once`

Do not stop after installing the dependency. Complete the repo-local setup as well.

## Required End State

When you are done, the consuming repo should contain:

- `pi.config.json`
- `TODOS.md` if the repo does not already have one
- `pi/DEVELOPER.md`
- `pi/TESTER.md`
- package scripts for the harness commands
- `.gitignore` entries for harness runtime/output files

If the repo already has equivalent files, update them instead of creating duplicates.

## Setup Steps

1. Install the package.

Preferred command:

```bash
npm install -D @sebastianandreasson/pi-autonomous-agents
```

If the repo uses another package manager already, use the repo-native equivalent instead.

2. Create `pi.config.json`.

- Start from `node_modules/@sebastianandreasson/pi-autonomous-agents/templates/pi.config.example.json`.
- Copy it into the repo root as `pi.config.json`.
- Update it for this repo:
  - `taskFile`: usually `TODOS.md`
  - `developerInstructionsFile`: `pi/DEVELOPER.md`
  - `testerInstructionsFile`: `pi/TESTER.md`
  - `commitMode`: normally `agent`
  - `promptMode`: normally `compact`
  - `testCommand`: a fast bounded verification command for this repo
  - `visualCaptureCommand`: only if this repo has a real screenshot capture flow
  - `models` / `piModel` / `visualReviewModel` / `roleModels`: configure the models actually available in this environment

Important:

- Do not assume a local provider’s served model id matches a GGUF filename or a guessed name.
- If the repo uses custom OpenAI-compatible providers, verify the exact served ids from each provider’s `/v1/models` response before finalizing `piModel`, `visualReviewModel`, or `roleModels`.

3. Create role instruction files.

- Copy `node_modules/@sebastianandreasson/pi-autonomous-agents/templates/DEVELOPER.md` to `pi/DEVELOPER.md`.
- Copy `node_modules/@sebastianandreasson/pi-autonomous-agents/templates/TESTER.md` to `pi/TESTER.md`.
- Customize both files for the repo:
  - name the actual product/app
  - describe the real verification expectations
  - mention project-specific constraints, startup flow, or directories
  - keep the harness workflow intact

4. Ensure `TODOS.md` exists.

- If the repo already uses a task file, keep it.
- Otherwise create a minimal `TODOS.md` with at least one phase heading and one unchecked actionable checkbox.

Minimal example:

```md
## Phase 1

- [ ] Define the first real task for this repo
```

5. Add package scripts.

- `pi:once` and `pi:run` should use default `sdk` transport unless the repo has a very specific reason not to.
- `pi:run` will also host local orchestration web UI by default.
- `pi:mock` is for setup validation when real PI execution is not ready yet.

Add these scripts to the consuming repo `package.json`, adapting only if necessary:

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

If the repo already has scripts with those names, update them instead of duplicating.

6. Update `.gitignore`.

Add the entries from:

- `node_modules/@sebastianandreasson/pi-autonomous-agents/templates/gitignore.fragment`

Merge them into the repo `.gitignore` without duplicating existing lines.

7. Pick a safe default verification command.

Important:

- `testCommand` must be fast and bounded.
- Do not use a long end-to-end happy-path spec as the inner-loop default.
- Prefer smoke tests or a narrow targeted command.

If the repo does not yet have a good smoke command, set `testCommand` to an empty string and note that setup is incomplete.

8. Configure models conservatively.

Recommended pattern:

- local model for `developer`
- local model for `developerRetry`
- local model for `developerFix`
- local or slightly stronger model for `tester`
- stronger frontier model for `visualReview` only if available
- keep `commitMode` as `agent` unless the repo explicitly needs legacy harness-managed commit-plan parsing
- keep large-file thresholds sensible for local models (`largeFileWarningLines`, `largeSpecWarningLines`)

Example shape:

```json
{
  "piModel": "local/dev-model",
  "visualReviewModel": "cloud/vision-model",
  "roleModels": {
    "developer": "local/dev-model",
    "developerRetry": "local/dev-model",
    "developerFix": "local/dev-model",
    "tester": "local/tester-model",
    "testerCommit": "local/tester-model",
    "visualReview": "cloud/vision-model"
  }
}
```

If the repo uses a custom OpenAI-compatible local provider, validate it directly:

1. Verify the endpoint is reachable.
2. Query `<baseUrl>/models`.
3. Use the exact returned model id.
4. Do not assume the served id equals a GGUF filename on disk.

If the repo overrides `PI_CODING_AGENT_DIR`:

- do not point it at an empty directory
- ensure that PI home is already bootstrapped
- ensure `models.json` exists there before running the harness

If `PI_CODING_AGENT_DIR` is set to a repo-local PI home and `models.json` is missing, setup is incomplete.

9. Validate the setup.

Run at least:

```bash
PI_CONFIG_FILE=pi.config.json pi-harness once
```

If the repo is not ready for a real run yet, at minimum run:

```bash
PI_CONFIG_FILE=pi.config.json PI_TRANSPORT=mock PI_TEST_CMD= pi-harness once
```

Default transport is `sdk`. Only set `PI_TRANSPORT` when you explicitly want `mock`.

If setup validation fails, fix the config rather than leaving a half-configured repo.

The harness should fail fast if:

- PI cannot list models
- a configured PI role model does not exist
- a configured provider endpoint is unreachable
- a configured provider does not serve the configured model id

For prompt debugging, inspect `.pi-last-prompt.txt` after a run. It contains the exact assembled prompt that was sent for the active role.
For flow debugging, inspect `.pi-last-iteration.json` after a run. It summarizes the selected task, repo-change outcome, tester verdict, commit-plan state, and terminal reason.

## Agent Rules

- Reuse existing repo conventions where possible.
- Do not replace project-specific instructions with generic text if good instructions already exist.
- Do not invent fake test commands or model endpoints.
- Do not enable visual review unless the repo actually has a usable capture command and model config.
- Keep changes minimal and local to harness setup.
- Prefer very small, implementation-shaped TODO items for local models. Broad tasks tend to create long turns, retries, and weak tester behavior.
- Prefer `read` for code inspection and keep shell usage focused on `git`, tests, and narrow diagnostics, especially for weaker local models.

## What To Report Back

When setup is complete, report:

- which files were created or updated
- which verification command was configured
- whether visual review was enabled
- which roles were mapped to which models
- whether validation was run successfully

## Resetting Harness State

If the user wants to start over from a clean slate later, use:

```bash
PI_CONFIG_FILE=pi.config.json pi-harness clear-history
```

This should remove harness-generated runtime/history state only, not project source files.

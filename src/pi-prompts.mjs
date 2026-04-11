import path from 'node:path'

function shortName(filePath) {
  return path.basename(filePath)
}

function formatVisualFeedback(visualFeedback) {
  const text = String(visualFeedback ?? '').trim()
  if (text === '') {
    return ''
  }

  return `\nLatest visual feedback from prior runs:\n${text}\n`
}

function formatTesterFeedback(testerFeedback) {
  const text = String(testerFeedback ?? '').trim()
  if (text === '') {
    return ''
  }

  return `\nLatest tester feedback from prior runs:\n${text}\n`
}

export function buildMainPrompt(config, options = {}) {
  const taskFile = shortName(config.taskFile)
  const instructionsFile = shortName(config.developerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(options.visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(options.testerFeedback)

  return `Read ${taskFile} and ${instructionsFile}.
${visualFeedbackSection}
${testerFeedbackSection}

Work only on the current phase.
Select the first unchecked actionable checkbox in phase order.
Complete that task, or at most 2 tightly related unchecked tasks if they are naturally done together.

Rules:
- Start by checking git status so you know whether unrelated changes already exist.
- Update code, config, and docs only as needed for the selected task.
- Tick only the checkbox items that are actually completed.
- Do not select "Done when" checkboxes as the active task unless the implementation items in that section are already satisfied.
- If you discover missing prerequisite work, add a new unchecked checkbox under the same phase, then complete only what is necessary.
- Do not skip to a later phase unless the current task is blocked.
- If blocked, add a brief note directly under the relevant task in ${taskFile} explaining the blocker, then stop.
- Do not create GitHub issue templates, project-management files, or unrelated scaffolding.
- Do not edit lockfiles, generated files, or unrelated assets.
- If dependencies must change, edit package.json only, then stop.
	- Prefer the smallest viable implementation that fully satisfies the selected checkbox.
	- Avoid broad refactors unless the selected task explicitly requires them.
	- Trust tool results over your own guesses. If a read tool shows file contents, use that exact output instead of arguing with it.
	- Do not repeatedly rewrite the same file because you suspect a formatting issue. Read once, identify the exact mismatch, then make one focused fix.
	- Do not create the final commit during the developer pass. Leave a clean diff for the tester to validate and commit if it passes.

Before stopping:
- Tick completed checkbox items in ${taskFile}.
	- Keep changes scoped to one coherent step.
	- Stop after finishing that step.`
}

export function buildFixPrompt(config, recentVerificationOutput, options = {}) {
  const taskFile = shortName(config.taskFile)
  const instructionsFile = shortName(config.developerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(options.visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(options.testerFeedback)

  return `Read ${taskFile} and ${instructionsFile}.
${visualFeedbackSection}
${testerFeedbackSection}

The tester step found a real problem in the current implementation. Fix only the product behavior related to the current phase and current task.

Recent tester findings:
${recentVerificationOutput}

Rules:
- Start by checking git status so you know which files are already dirty.
- Do not paper over product bugs by weakening tests.
- Prefer fixing product code over rewriting tests.
- Update tests only when the tester exposed a real gap in coverage or testability.
- Do not create docs, issue templates, or unrelated scaffolding.
- Do not edit lockfiles or other generated files.
- If dependencies must change, edit package.json only, then stop.
	- Keep changes minimal and focused on the failing behavior.
	- Trust tool results over your own guesses. If a read tool shows file contents, use that exact output instead of arguing with it.
	- Do not repeatedly rewrite the same file because you suspect a formatting issue. Read once, identify the exact mismatch, then make one focused fix.
	- Do not create the final commit during the developer fix pass. Leave the repaired diff for the tester to re-check and commit if it passes.

Before stopping:
	- Tick any checkbox in ${taskFile} only if it is now actually complete.
	- Stop after one coherent fix.`
}

export function buildSteeringPrompt(config, reason, options = {}) {
  const taskFile = shortName(config.taskFile)
  const visualFeedbackSection = formatVisualFeedback(options.visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(options.testerFeedback)

  return `Continue from the current repo state.
${visualFeedbackSection}
${testerFeedbackSection}

Reason for this follow-up: ${reason}

Read ${taskFile}, select the first unchecked actionable checkbox in the current phase, complete one coherent task, tick completed items, run verification, and stop.

Additional guardrails:
- Do not repeat the same tool call over and over.
- If you already read a file, use that context instead of rereading it unless something changed.
- If you are stuck, make the smallest decisive next action or stop and state the blocker.`
}

export function buildTesterPrompt(config, {
  phase,
  task,
  changedFiles,
  developerNotes,
  reason = 'tester_review',
  visualFeedback = '',
  testerFeedback = '',
}) {
  const taskFile = shortName(config.taskFile)
  const instructionsFile = shortName(config.testerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(testerFeedback)
  const changedFilesSection = changedFiles.length > 0
    ? changedFiles.map((file) => `- ${file}`).join('\n')
    : '- No file changes were detected from the developer turn.'
  const verificationCommand = config.testCommand.trim() === '' ? '(not configured)' : config.testCommand
  const visualCaptureNote = config.visualReviewEnabled
    ? `\n- Maintain the screenshot capture flow used by the harness (${config.visualCaptureCommand || 'PI_VISUAL_CAPTURE_CMD'}) so current visual artifacts and manifest are produced for visual review.`
    : ''

  return `Read ${taskFile} and ${instructionsFile}.
${visualFeedbackSection}
${testerFeedbackSection}

You are the TESTER role. You are reviewing the most recent developer work from an independent quality and functionality perspective.

Current phase: ${phase}
Current task: ${task}
Reason for this tester pass: ${reason}

Developer notes:
${developerNotes || '(none provided)'}

Files changed by the developer:
${changedFilesSection}

	Your responsibilities:
	- Inspect the implementation from a skeptical user/tester viewpoint.
	- Add or update verification focused on the changed behavior.
	- Prefer browser-driven checks and targeted tests over broad rewrites.
	- Run the repo verification command yourself: ${verificationCommand}
	- Decide whether the feature is actually functionally correct for the intended task, not just whether the code looks plausible.
	- For any user-facing flow, validate the actual playable path in the running app, not just the source code.
	- If the task touches menus, unlocks, progression, classes, routes, shops, onboarding, or gating, verify a fresh-save path so a brand-new player can still start and use the feature.
${visualCaptureNote}

	Rules:
	- Start by checking git status so you can separate this task from unrelated dirty files.
	- Prefer editing tests, fixtures, and minimal observability hooks.
	- Avoid editing product code unless a tiny testability hook is essential and does not change user-facing behavior.
	- If you find a real product bug or incomplete functionality, do not hide it with brittle tests.
	- If blocked by tooling or environment, state the blocker clearly.
	- Trust tool results over your own guesses. If a read tool shows file contents, use that exact output instead of arguing with it.
	- Treat "the player cannot start, continue, select, buy, unlock, or exit correctly" as a FAIL even if the code compiles.
	- Before PASS, identify at least one concrete player-visible success path you exercised and one thing you checked for regressions.
	- If your verdict is PASS and the verification command succeeded, do not run git add or git commit yourself. Instead, provide a commit plan for the harness to execute.
	- The commit plan must include only the files related to this task. If the working tree is too messy to isolate safely, use VERDICT: BLOCKED instead of guessing.
	- Use a concise commit message in the format <type>(<scope>): <summary> when possible.
	- Stop after one coherent tester pass.

	Before the verdict line, include a short section in plain text with:
	- Observed flow:
	- Player-facing result:
	- Regression check:

	If and only if your verdict is PASS, also include exactly this commit plan block before the verdict line:
	- COMMIT_MESSAGE: <one-line commit message>
	- COMMIT_FILES:
	- path/to/file-one
	- path/to/file-two

	Before stopping, end your final response with exactly one verdict line:
	- VERDICT: PASS
	- VERDICT: FAIL
	- VERDICT: BLOCKED`
}

export function buildCommitPrompt(config, {
  phase,
  task,
  changedFiles,
  developerNotes,
  reason = 'tester_passed_without_commit',
  visualFeedback = '',
  testerFeedback = '',
}) {
  const taskFile = shortName(config.taskFile)
  const instructionsFile = shortName(config.testerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(testerFeedback)
  const changedFilesSection = changedFiles.length > 0
    ? changedFiles.map((file) => `- ${file}`).join('\n')
    : '- No changed files were detected. Inspect git status before deciding whether a commit is possible.'

  return `Read ${taskFile} and ${instructionsFile}.
${visualFeedbackSection}
${testerFeedbackSection}

You are the TESTER role. The implementation already passed functional review, but the final commit was not created.

Current phase: ${phase}
Current task: ${task}
Reason for this follow-up: ${reason}

Developer/tester notes:
${developerNotes || '(none provided)'}

Files currently dirty:
${changedFilesSection}

Your job now is commit-plan finalization only. Do not run git commands yourself.

Rules:
- Start by checking git status so you can see exactly which files are dirty.
- Do not change product code, tests, docs, or TODO items in this pass.
- Select only the files related to this task.
- Use a concise commit message in the format <type>(<scope>): <summary> when possible.
- If the working tree is too messy to isolate safely, do not guess. End with VERDICT: BLOCKED.

If you can isolate the correct commit, include exactly this block before the verdict line:
- COMMIT_MESSAGE: <one-line commit message>
- COMMIT_FILES:
- path/to/file-one
- path/to/file-two

Before stopping, end your final response with exactly one verdict line:
- VERDICT: PASS
- VERDICT: BLOCKED`
}

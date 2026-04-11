import path from 'node:path'

function displayPath(config, filePath) {
  const relativePath = path.relative(config.cwd, filePath)
  if (
    relativePath !== ''
    && !relativePath.startsWith('..')
    && !path.isAbsolute(relativePath)
  ) {
    return relativePath.split(path.sep).join('/')
  }

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

function indentBlock(text, prefix = '') {
  return String(text)
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function innerLoopValidationRules(verificationCommand) {
  const command = String(verificationCommand ?? '').trim() || 'the configured smoke verification command'
  return [
    `- Use ${command} as the fast inner-loop gate. Do not substitute a long real-time full-flow spec unless the task explicitly requires it.`,
    '- If a long Playwright happy-path spec changes, validate with smoke plus one narrow targeted spec or deterministic state hook, not the entire full-flow run.',
    '- Reserve long full-flow Playwright specs for an explicit nightly or post-run lane, not the developer turn.',
  ].join('\n')
}

function staleEditRecoveryRules() {
  return [
    '- After one failed edit attempt, reread the file before trying again.',
    '- Do not repeat the same exact oldText-based edit on the same file.',
  ].join('\n')
}

function repoInstructionsAuthorityLine(config, instructionsFile, usesBundledInstructions) {
  if (usesBundledInstructions) {
    return ''
  }

  return `Repo-local instructions in ${displayPath(config, instructionsFile)} are the primary role contract. Follow them over package defaults when they differ.\n`
}

export function buildMainPrompt(config, options = {}) {
  const taskFile = displayPath(config, config.taskFile)
  const instructionsFile = displayPath(config, config.developerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(options.visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(options.testerFeedback)
  const authorityLine = repoInstructionsAuthorityLine(
    config,
    config.developerInstructionsFile,
    config.usingBundledDeveloperInstructions,
  )

  if (!config.usingBundledDeveloperInstructions) {
    return `Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
${testerFeedbackSection}

Work only on the current phase.
Select the first unchecked actionable checkbox in phase order.
Complete one coherent task, or at most 2 tightly related unchecked tasks if they are naturally done together.

Harness rules:
- Start by checking git status so you know whether unrelated changes already exist.
- Update code, config, and docs only as needed for the selected task.
- Tick only the checkbox items that are actually completed.
- If blocked, add a brief note directly under the relevant task in ${taskFile} explaining the blocker, then stop.
- Do not create the final commit during the developer pass.
${staleEditRecoveryRules()}

Before stopping:
- Tick completed checkbox items in ${taskFile}.
- Keep changes scoped to one coherent step.
- Stop after finishing that step.`
  }

  return `Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
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
${indentBlock(innerLoopValidationRules(config.testCommand), '\t')}
	- Trust tool results over your own guesses. If a read tool shows file contents, use that exact output instead of arguing with it.
	- Do not repeatedly rewrite the same file because you suspect a formatting issue. Read once, identify the exact mismatch, then make one focused fix.
${indentBlock(staleEditRecoveryRules(), '\t')}
	- Do not create the final commit during the developer pass. Leave a clean diff for the tester to validate and commit if it passes.

Before stopping:
- Tick completed checkbox items in ${taskFile}.
	- Keep changes scoped to one coherent step.
	- Stop after finishing that step.`
}

export function buildFixPrompt(config, recentVerificationOutput, options = {}) {
  const taskFile = displayPath(config, config.taskFile)
  const instructionsFile = displayPath(config, config.developerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(options.visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(options.testerFeedback)
  const authorityLine = repoInstructionsAuthorityLine(
    config,
    config.developerInstructionsFile,
    config.usingBundledDeveloperInstructions,
  )

  if (!config.usingBundledDeveloperInstructions) {
    return `Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
${testerFeedbackSection}

The tester step found a real problem in the current implementation. Fix only the product behavior related to the current phase and current task.

Recent tester findings:
${recentVerificationOutput}

Harness rules:
- Start by checking git status so you know which files are already dirty.
- Do not paper over product bugs by weakening tests.
- Keep changes minimal and focused on the failing behavior.
- Do not perform speculative cleanup or unrelated refactors in this pass.
- Do not create the final commit during the developer fix pass.
${staleEditRecoveryRules()}

Before stopping:
- Tick any checkbox in ${taskFile} only if it is now actually complete.
- Stop after one coherent fix.`
  }

  return `Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
${testerFeedbackSection}

The tester step found a real problem in the current implementation. Fix only the product behavior related to the current phase and current task.

Recent tester findings:
${recentVerificationOutput}

Rules:
- Start by checking git status so you know which files are already dirty.
- Do not paper over product bugs by weakening tests.
- Prefer fixing product code over rewriting tests.
- Update tests only when the tester exposed a real gap in coverage or testability.
- Do not perform speculative cleanup or unrelated refactors in this pass.
- Do not create docs, issue templates, or unrelated scaffolding.
- Do not edit lockfiles or other generated files.
- If dependencies must change, edit package.json only, then stop.
	- Keep changes minimal and focused on the failing behavior.
${indentBlock(innerLoopValidationRules(config.testCommand), '\t')}
	- Trust tool results over your own guesses. If a read tool shows file contents, use that exact output instead of arguing with it.
	- Do not repeatedly rewrite the same file because you suspect a formatting issue. Read once, identify the exact mismatch, then make one focused fix.
${indentBlock(staleEditRecoveryRules(), '\t')}
	- Do not create the final commit during the developer fix pass. Leave the repaired diff for the tester to re-check and commit if it passes.

Before stopping:
	- Tick any checkbox in ${taskFile} only if it is now actually complete.
	- Stop after one coherent fix.`
}

export function buildSteeringPrompt(config, reason, options = {}) {
  const taskFile = displayPath(config, config.taskFile)
  const instructionsFile = displayPath(config, config.developerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(options.visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(options.testerFeedback)
  const authorityLine = repoInstructionsAuthorityLine(
    config,
    config.developerInstructionsFile,
    config.usingBundledDeveloperInstructions,
  )

  if (!config.usingBundledDeveloperInstructions) {
    return `Continue from the current repo state.
Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
${testerFeedbackSection}

Reason for this follow-up: ${reason}

Select the first unchecked actionable checkbox in the current phase, complete one coherent task, tick completed items, run any repo-local verification required by your role instructions, and stop.

Additional harness guardrails:
- Start by checking git status.
- Do not repeat the same tool call over and over.
- If you already read a file, use that context instead of rereading it unless something changed.
- If an edit fails once, reread the file before retrying. Do not repeat the same exact edit attempt.
- If you are stuck, make the smallest decisive next action or stop and state the blocker.`
  }

  return `Continue from the current repo state.
Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
${testerFeedbackSection}

Reason for this follow-up: ${reason}

Read ${taskFile}, select the first unchecked actionable checkbox in the current phase, complete one coherent task, tick completed items, run verification, and stop.

Additional guardrails:
- Do not repeat the same tool call over and over.
- If you already read a file, use that context instead of rereading it unless something changed.
- If an edit fails once, reread the file before retrying. Do not repeat the same exact edit attempt.
- Prefer the configured smoke verification path and one narrow targeted check over long full-flow Playwright specs.
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
  const taskFile = displayPath(config, config.taskFile)
  const instructionsFile = displayPath(config, config.testerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(testerFeedback)
  const changedFilesSection = changedFiles.length > 0
    ? changedFiles.map((file) => `- ${file}`).join('\n')
    : '- No file changes were detected from the developer turn.'
  const verificationCommand = config.testCommand.trim() === '' ? '(not configured)' : config.testCommand
  const visualCaptureNote = config.visualReviewEnabled
    ? `\n- Maintain the screenshot capture flow used by the harness (${config.visualCaptureCommand || 'PI_VISUAL_CAPTURE_CMD'}) so current visual artifacts and manifest are produced for visual review.`
    : ''
  const authorityLine = repoInstructionsAuthorityLine(
    config,
    config.testerInstructionsFile,
    config.usingBundledTesterInstructions,
  )

  if (!config.usingBundledTesterInstructions) {
    return `Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
${testerFeedbackSection}

You are the TESTER role. You are reviewing the most recent developer work from an independent quality and functionality perspective.

Current phase: ${phase}
Current task: ${task}
Reason for this tester pass: ${reason}

Developer notes:
${developerNotes || '(none provided)'}

Files changed by the developer:
${changedFilesSection}

Harness rules:
- Start by checking git status so you can separate this task from unrelated dirty files.
- Follow the repo-local tester instructions for what to verify and which commands to run.
- If blocked by tooling or environment, state the blocker clearly.
- If you find a real product bug or incomplete functionality, do not hide it with brittle tests.
- If you cannot finish a reliable review in one pass, return VERDICT: BLOCKED instead of continuing analysis indefinitely.
${staleEditRecoveryRules()}
- If your verdict is PASS, do not run git add or git commit yourself. Provide a commit plan for the harness to execute.
- The commit plan must include only the files related to this task. If the working tree is too messy to isolate safely, use VERDICT: BLOCKED instead of guessing.
- If you can produce a PASS, include the commit plan in the same response. Avoid making the harness ask for a second commit-only pass.
- Stop after one coherent tester pass.${visualCaptureNote}

Before the verdict line, include a short section in plain text with:
- Observed flow:
- Player-facing result:
- Regression check:

If and only if your verdict is PASS, also include exactly this commit plan block before the verdict line:
- COMMIT_MESSAGE: <one-line commit message>
- COMMIT_FILES:
- path/to/file-one
- path/to/file-two

Do not add commentary on the same lines as COMMIT_MESSAGE or COMMIT_FILES. Put only the message value after COMMIT_MESSAGE:, then one file path per line under COMMIT_FILES:.

Before stopping, end your final response with exactly one verdict line:
- VERDICT: PASS
- VERDICT: FAIL
- VERDICT: BLOCKED`
  }

  return `Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
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
${indentBlock(innerLoopValidationRules(verificationCommand), '\t')}
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
	- If you cannot finish a reliable review in one pass, return VERDICT: BLOCKED instead of continuing analysis indefinitely.
${indentBlock(staleEditRecoveryRules(), '\t')}
	- Treat "the player cannot start, continue, select, buy, unlock, or exit correctly" as a FAIL even if the code compiles.
	- Before PASS, identify at least one concrete player-visible success path you exercised and one thing you checked for regressions.
	- If your verdict is PASS and the verification command succeeded, do not run git add or git commit yourself. Instead, provide a commit plan for the harness to execute.
	- The commit plan must include only the files related to this task. If the working tree is too messy to isolate safely, use VERDICT: BLOCKED instead of guessing.
	- If you can produce a PASS, include the commit plan in the same response. Avoid making the harness ask for a second commit-only pass.
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

	Do not add commentary on the same lines as COMMIT_MESSAGE or COMMIT_FILES. Put only the message value after COMMIT_MESSAGE:, then one file path per line under COMMIT_FILES:.

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
  const taskFile = displayPath(config, config.taskFile)
  const instructionsFile = displayPath(config, config.testerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(testerFeedback)
  const authorityLine = repoInstructionsAuthorityLine(
    config,
    config.testerInstructionsFile,
    config.usingBundledTesterInstructions,
  )
  const changedFilesSection = changedFiles.length > 0
    ? changedFiles.map((file) => `- ${file}`).join('\n')
    : '- No changed files were detected. Inspect git status before deciding whether a commit is possible.'

  return `Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
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

Do not add commentary on the same lines as COMMIT_MESSAGE or COMMIT_FILES. Put only the message value after COMMIT_MESSAGE:, then one file path per line under COMMIT_FILES:.

Before stopping, end your final response with exactly one verdict line:
- VERDICT: PASS
- VERDICT: BLOCKED`
}

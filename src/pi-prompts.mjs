import path from 'node:path'

function clampLines(text, maxLines) {
  const normalized = String(text ?? '').trim()
  if (normalized === '') {
    return ''
  }

  const lines = normalized.split('\n')
  if (!Number.isFinite(maxLines) || maxLines <= 0 || lines.length <= maxLines) {
    return normalized
  }

  const remaining = lines.length - maxLines
  return `${lines.slice(0, maxLines).join('\n')}\n... (${remaining} more lines omitted)`
}

function formatFeedbackSection(label, text, maxLines) {
  const excerpt = clampLines(text, maxLines)
  if (excerpt === '') {
    return ''
  }

  return `\n${label}:\n${excerpt}\n`
}

function formatChangedFilesSection(files, maxFiles) {
  const list = Array.isArray(files) ? files.filter(Boolean) : []
  if (list.length === 0) {
    return '- No file changes were detected from the prior turn.'
  }

  const limit = Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : list.length
  const visible = list.slice(0, limit)
  const remaining = list.length - visible.length
  const lines = visible.map((file) => `- ${file}`)
  if (remaining > 0) {
    lines.push(`- ... and ${remaining} more files`)
  }
  return lines.join('\n')
}

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

function formatVisualFeedback(config, visualFeedback) {
  return formatFeedbackSection(
    'Latest visual feedback from prior runs',
    visualFeedback,
    configMaxLines(config, 'maxVisualFeedbackLines', 20),
  )
}

function formatTesterFeedback(config, testerFeedback) {
  return formatFeedbackSection(
    'Latest tester feedback from prior runs',
    testerFeedback,
    configMaxLines(config, 'maxTesterFeedbackLines', 32),
  )
}

function configMaxLines(config, key, fallback) {
  const value = Number(config?.[key])
  return Number.isFinite(value) && value > 0 ? value : fallback
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

function testerPassOwnershipRules(config) {
  if (config.commitMode === 'plan') {
    return {
      successRule: '- If your verdict is PASS, do not run git add or git commit yourself. Provide a commit plan for the harness to execute.',
      isolationRule: '- The commit plan must include only the files related to this task. If the working tree is too messy to isolate safely, use VERDICT: BLOCKED instead of guessing.',
      extraRule: '- If you can produce a PASS, include the commit plan in the same response. Avoid making the harness ask for a second commit-only pass.',
      successFormat: [
        'If and only if your verdict is PASS, also include exactly this commit plan block before the verdict line:',
        '- COMMIT_MESSAGE: <one-line commit message>',
        '- COMMIT_FILES:',
        '- path/to/file-one',
        '- path/to/file-two',
        '',
        'Do not add commentary on the same lines as COMMIT_MESSAGE or COMMIT_FILES. Put only the message value after COMMIT_MESSAGE:, then one file path per line under COMMIT_FILES:.',
      ].join('\n'),
    }
  }

  return {
    successRule: '- If your verdict is PASS, stage only the files related to this task and create the git commit yourself before the verdict line.',
    isolationRule: '- If the working tree is too messy to isolate safely, use VERDICT: BLOCKED instead of guessing.',
    extraRule: '- Use git status before committing, stage only the related files, and create one concise commit message in the format <type>(<scope>): <summary> when possible.',
    successFormat: [
      'If and only if your verdict is PASS, include exactly this block before the verdict line after creating the commit:',
      '- COMMIT_CREATED: true',
      '- COMMIT_MESSAGE: <one-line commit message>',
      '- COMMIT_SHA: <short-or-full-sha>',
    ].join('\n'),
  }
}

export function buildMainPrompt(config, options = {}) {
  const taskFile = displayPath(config, config.taskFile)
  const instructionsFile = displayPath(config, config.developerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(config, options.visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(config, options.testerFeedback)
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

Do one current-phase unchecked task.

Rules:
- Start with git status.
- Select the first unchecked actionable checkbox in phase order.
- Keep changes minimal and scoped.
- Tick only completed items.
- If blocked, note it under the task in ${taskFile} and stop.
- Do not touch lockfiles, generated files, or unrelated assets.
- Do not commit in the developer pass.
${innerLoopValidationRules(config.testCommand)}
${staleEditRecoveryRules()}

Before stopping:
- Tick completed checkbox items in ${taskFile}.
- Stop after one coherent step.`
}

export function buildFixPrompt(config, recentVerificationOutput, options = {}) {
  const taskFile = displayPath(config, config.taskFile)
  const instructionsFile = displayPath(config, config.developerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(config, options.visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(config, options.testerFeedback)
  const authorityLine = repoInstructionsAuthorityLine(
    config,
    config.developerInstructionsFile,
    config.usingBundledDeveloperInstructions,
  )
  const findings = clampLines(recentVerificationOutput, configMaxLines(config, 'maxVerificationExcerptLines', 40))

  if (!config.usingBundledDeveloperInstructions) {
    return `Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
${testerFeedbackSection}

The tester step found a real problem in the current implementation. Fix only the product behavior related to the current phase and current task.

Recent tester findings:
${findings}

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
${findings}

Rules:
- Start with git status.
- Keep the fix narrow.
- Do not weaken tests to hide product bugs.
- Do not perform speculative cleanup or unrelated refactors.
- Do not create the final commit.
${staleEditRecoveryRules()}

Before stopping:
- Tick any checkbox in ${taskFile} only if it is now actually complete.
- Stop after one coherent fix.`
}

export function buildSteeringPrompt(config, reason, options = {}) {
  const taskFile = displayPath(config, config.taskFile)
  const instructionsFile = displayPath(config, config.developerInstructionsFile)
  const visualFeedbackSection = formatVisualFeedback(config, options.visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(config, options.testerFeedback)
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

Select the first unchecked actionable checkbox in the current phase, complete one coherent task, tick completed items, run verification, and stop.

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
  const visualFeedbackSection = formatVisualFeedback(config, visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(config, testerFeedback)
  const changedFilesSection = formatChangedFilesSection(
    changedFiles,
    configMaxLines(config, 'maxPromptChangedFiles', 10),
  )
  const compactDeveloperNotes = clampLines(
    developerNotes || '(none provided)',
    configMaxLines(config, 'maxPromptNotesLines', 16),
  )
  const verificationCommand = config.testCommand.trim() === '' ? '(not configured)' : config.testCommand
  const visualCaptureNote = config.visualReviewEnabled
    ? `\n- Keep the screenshot capture flow working so the harness still produces current visual artifacts for review.`
    : ''
  const authorityLine = repoInstructionsAuthorityLine(
    config,
    config.testerInstructionsFile,
    config.usingBundledTesterInstructions,
  )
  const passOwnership = testerPassOwnershipRules(config)

  if (!config.usingBundledTesterInstructions) {
    return `Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
${testerFeedbackSection}

You are the TESTER role. You are reviewing the most recent developer work from an independent quality and functionality perspective.

Current phase: ${phase}
Current task: ${task}
Reason for this tester pass: ${reason}

Developer notes:
${compactDeveloperNotes}

Files changed by the developer:
${changedFilesSection}

Rules:
- Start with git status.
- Follow repo-local tester instructions for what to verify and which commands to run.
- Prefer one focused review pass.
- If blocked or inconclusive, return VERDICT: BLOCKED.
- Do not hide real bugs with brittle tests.
- ${passOwnership.successRule.slice(2)}
- ${passOwnership.isolationRule.slice(2)}
- ${passOwnership.extraRule.slice(2)}${visualCaptureNote}

Before the verdict line, include a short section in plain text with:
- Observed flow:
- Player-facing result:
- Regression check:

${passOwnership.successFormat}

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
${compactDeveloperNotes}

Files changed by the developer:
${changedFilesSection}

	Rules:
	- Start with git status.
	- Run the repo verification command yourself: ${verificationCommand}
${indentBlock(innerLoopValidationRules(verificationCommand), '\t')}
	- Prefer one focused browser-driven review pass.
	- Do not hide real bugs with brittle tests.
	- If blocked or inconclusive, return VERDICT: BLOCKED.
${indentBlock(passOwnership.successRule, '\t')}
${indentBlock(passOwnership.isolationRule, '\t')}
${indentBlock(passOwnership.extraRule, '\t')}${visualCaptureNote}

	Before the verdict line, include a short section in plain text with:
	- Observed flow:
	- Player-facing result:
	- Regression check:

${indentBlock(passOwnership.successFormat, '\t')}

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
  const visualFeedbackSection = formatVisualFeedback(config, visualFeedback)
  const testerFeedbackSection = formatTesterFeedback(config, testerFeedback)
  const authorityLine = repoInstructionsAuthorityLine(
    config,
    config.testerInstructionsFile,
    config.usingBundledTesterInstructions,
  )
  const changedFilesSection = formatChangedFilesSection(
    changedFiles,
    configMaxLines(config, 'maxPromptChangedFiles', 10),
  )
  const compactDeveloperNotes = clampLines(
    developerNotes || '(none provided)',
    configMaxLines(config, 'maxPromptNotesLines', 16),
  )

  return `Read ${taskFile} and ${instructionsFile}.
${authorityLine}${visualFeedbackSection}
${testerFeedbackSection}

You are the TESTER role. The implementation already passed functional review, but the final commit was not created.

Current phase: ${phase}
Current task: ${task}
Reason for this follow-up: ${reason}

Developer/tester notes:
${compactDeveloperNotes}

Files currently dirty:
${changedFilesSection}

Your job now is commit-plan finalization only. Do not run git commands yourself.

Rules:
- Start with git status.
- Do not change product code, tests, docs, or TODO items in this pass.
- Select only the files related to this task.
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

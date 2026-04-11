#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

async function readRequest() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') {
    throw new Error('Expected JSON request on stdin.')
  }

  return JSON.parse(raw)
}

function toDataUrl(buffer, filePath) {
  const extension = path.extname(filePath).toLowerCase()
  const mime = extension === '.jpg' || extension === '.jpeg'
    ? 'image/jpeg'
    : extension === '.webp'
      ? 'image/webp'
      : 'image/png'
  return `data:${mime};base64,${buffer.toString('base64')}`
}

function buildPrompt(request, screenshots) {
  const changedFilesText = Array.isArray(request.changedFiles) && request.changedFiles.length > 0
    ? request.changedFiles.map((file) => `- ${file}`).join('\n')
    : '- (unknown)'
  const screensText = screenshots.map((screen, index) => `${index + 1}. ${screen.label} (${screen.id})`).join('\n')

  return [
    'You are a visual gameplay reviewer.',
    'Review the supplied screenshots from the current build.',
    'Focus on player-facing visual and UX issues, not code style.',
    'Ignore tiny aesthetic preferences. Flag only meaningful problems.',
    '',
    `Phase: ${request.phase || 'unknown'}`,
    `Task: ${request.task || 'unknown'}`,
    '',
    'Changed files:',
    changedFilesText,
    '',
    'Screens provided:',
    screensText,
    '',
    'Write concise Markdown with exactly these sections and nothing else:',
    '## Observed Flow',
    '## Visual Findings',
    '## Player Impact',
    '## Verdict',
    '',
    'Keep each section to 1-3 short bullet points or 1 short paragraph.',
    'Under ## Verdict, write exactly one line in this exact format:',
    'VERDICT: PASS',
    'or',
    'VERDICT: FAIL',
    'or',
    'VERDICT: BLOCKED',
    '',
    'If the screenshots show an impossible player path, black screen, unusable UI, missing affordance, or severe visual regression, use FAIL.',
    'Use BLOCKED only if the screenshots are insufficient to judge the flow.',
    'Call out missing affordances, overlap, clipping, unreadable text, confusing selection states, impossible progression, or broken hierarchy.',
  ].join('\n')
}

function buildFallbackPrompt(request, screenshots) {
  const screensText = screenshots.map((screen, index) => `${index + 1}. ${screen.label} (${screen.id})`).join('\n')

  return [
    'You are a visual gameplay reviewer.',
    'Review the supplied screenshots and answer briefly.',
    `Phase: ${request.phase || 'unknown'}`,
    `Task: ${request.task || 'unknown'}`,
    '',
    'Screens provided:',
    screensText,
    '',
    'Reply with exactly these lines and nothing else:',
    'Visual summary: <one short sentence>',
    'VERDICT: PASS|FAIL|BLOCKED',
    '',
    'Use FAIL for a black screen, impossible progression, unusable UI, or severe visual regression.',
    'Do not output reasoning. Do not leave the verdict out.',
  ].join('\n')
}

function parseVerdict(text) {
  const match = String(text ?? '').match(/VERDICT:\s*(PASS|FAIL|BLOCKED)\b/i)
  return match?.[1]?.toUpperCase() ?? 'UNKNOWN'
}

function extractResponseText(content) {
  if (typeof content === 'string') {
    return content.trim()
  }

  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim()
  }

  return ''
}

async function createChatCompletion({ model, modelName, content, maxTokens }) {
  const response = await fetch(`${String(model.baseUrl).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Visual review API failed (${response.status}): ${errorText}`)
  }

  return response.json()
}

async function writeDebugResponse(feedbackFile, name, data) {
  const debugDir = path.join(path.dirname(feedbackFile), 'debug')
  await fs.mkdir(debugDir, { recursive: true })
  await fs.writeFile(path.join(debugDir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

async function main() {
  const request = await readRequest()
  const model = request.modelProfile
  if (!model?.baseUrl || !request.model) {
    throw new Error('Visual review requires a configured model and baseUrl.')
  }

  const screenshots = Array.isArray(request.screenshots) ? request.screenshots.slice(0, Number(request.maxImages ?? 8)) : []
  if (screenshots.length === 0) {
    throw new Error('Visual review requires at least one screenshot.')
  }

  const content = [{ type: 'text', text: buildPrompt(request, screenshots) }]
  for (const screenshot of screenshots) {
    const fileBuffer = await fs.readFile(screenshot.path)
    content.push({
      type: 'image_url',
      image_url: {
        url: toDataUrl(fileBuffer, screenshot.path),
      },
    })
  }

  const data = await createChatCompletion({
    model,
    modelName: request.model,
    content,
    maxTokens: 1200,
  })
  await writeDebugResponse(request.feedbackFile, 'last-primary-response.json', data)

  let output = extractResponseText(data?.choices?.[0]?.message?.content)
  let verdict = parseVerdict(output)

  if (output === '' || verdict === 'UNKNOWN') {
    const fallbackContent = [{ type: 'text', text: buildFallbackPrompt(request, screenshots) }]
    for (const screenshot of screenshots) {
      const fileBuffer = await fs.readFile(screenshot.path)
      fallbackContent.push({
        type: 'image_url',
        image_url: {
          url: toDataUrl(fileBuffer, screenshot.path),
        },
      })
    }

    const fallbackData = await createChatCompletion({
      model,
      modelName: request.model,
      content: fallbackContent,
      maxTokens: 200,
    })
    await writeDebugResponse(request.feedbackFile, 'last-fallback-response.json', fallbackData)
    const fallbackOutput = extractResponseText(fallbackData?.choices?.[0]?.message?.content)
    const fallbackVerdict = parseVerdict(fallbackOutput)
    if (fallbackOutput !== '' && fallbackVerdict !== 'UNKNOWN') {
      output = fallbackOutput
      verdict = fallbackVerdict
    }
  }

  if (output === '') {
    throw new Error('Visual review model returned empty content.')
  }

  if (verdict === 'UNKNOWN') {
    throw new Error(`Visual review output missing required verdict line.\n\n${output}`)
  }

  await fs.mkdir(path.dirname(request.feedbackFile), { recursive: true })
  await fs.writeFile(request.feedbackFile, `${output}\n`, 'utf8')

  process.stdout.write(`${JSON.stringify({
    status: 'success',
    verdict,
    output,
    feedbackFile: request.feedbackFile,
  })}\n`)
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    status: 'failed',
    verdict: 'BLOCKED',
    output: error instanceof Error ? error.stack ?? error.message : String(error),
    feedbackFile: '',
  })}\n`)
  process.exitCode = 1
})

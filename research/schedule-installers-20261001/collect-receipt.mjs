// Usage: node collect-receipt.mjs <isolated NAMZU_HOME> <tui-session-id> <run-session-id>.
// Only records tool names, bounded inputs/statuses and terminal outcomes.
// Omits system prompts, credentials, reasoning, web result bodies and file content.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [home, tuiSessionId, runSessionId] = process.argv.slice(2)
if (!home || !tuiSessionId || !runSessionId) throw new Error('Expected home and two session IDs')

function session(id) {
  const projects = join(home, 'projects')
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    let source
    try { source = readFileSync(join(projects, project.name, `${id}.jsonl`), 'utf8') }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const rows = source.trim().split('\n').map(line => JSON.parse(line))
    return {
      sessionId: id,
      firstToolRoster: rows.find(row => row.type === 'request_envelope')?.toolNames,
      webSearchResultCharacters: rows.filter(row => row.type === 'tool_completed' && row.toolName === 'web_search')
        .reduce((total, row) => total + String(row.result ?? '').length, 0),
      events: rows.filter(row => ['tool_input_completed', 'tool_completed', 'turn_completed', 'token_usage_updated'].includes(row.type))
        .map(row => {
          const receipt = { seq: row.seq, type: row.type }
          if (row.toolName) receipt.toolName = row.toolName
          if (row.type === 'tool_input_completed') {
            const input = row.input ?? {}
            for (const field of ['action', 'name', 'kind', 'when', 'tz', 'query', 'limit', 'file_path', 'path']) {
              if (input[field] !== undefined) receipt[field] = input[field]
            }
            if (input.permissions) receipt.permissions = input.permissions
            if (input.content !== undefined) receipt.contentCharacters = input.content.length
            if (input.prompt !== undefined) {
              receipt.promptTools = [...new Set(input.prompt.match(/\b(?:web_search|web_fetch|write|artifact)\b/g) ?? [])]
            }
          }
          if (row.type === 'tool_completed') {
            receipt.isError = row.isError ?? false
            if (row.isError || row.toolName === 'schedule' || row.toolName === 'write') {
              receipt.result = String(row.result).slice(0, 1500)
            }
          }
          if (row.type === 'turn_completed') receipt.stopReason = row.stopReason
          if (row.type === 'token_usage_updated') {
            receipt.usage = row.usage
            receipt.budget = row.budget
            receipt.contextTokens = row.contextTokens
          }
          return receipt
        }),
    }
  }
  throw new Error(`Session ${id} not found`)
}

process.stdout.write(`${JSON.stringify({
  installedCliVersion: '35.0.0',
  provider: 'zen',
  model: 'space-bunny-free',
  harnessLimits: { maxIterations: 12, tokenBudget: 200000, timeoutMs: 300000 },
  isolation: 'private test home and project; no scheduler service installed',
  initialRequest: 'Daily 10:00 AI news by model family in an artifact page',
  fallbackRequest: 'Daily 10:00 AI news in a local HTML file, distinct from an artifact page',
  caveats: [
    'The first two TUI turns reached the diagnostic time cap, including approval wait.',
    'The first schedule review was accidentally cancelled by test input; it is not a reproduced runtime defect.',
  ],
  tui: session(tuiSessionId),
  scheduledRun: session(runSessionId),
}, null, 2)}\n`)

// Native TUI fixture: scripted provider I/O, actual child runtime and shell tools.
// Use only with a new owned scratch NAMZU_HOME; no account traffic is sent.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const repo = process.env.NAMZU_CHILD_FIXTURE_REPO
const root = process.env.NAMZU_CHILD_FIXTURE_ROOT
if (!repo || !root) throw new Error('Set child fixture repo and scratch root.')
const { ProviderRegistry, MockLLMProvider } = await import(pathToFileURL(join(repo, 'packages/sdk/dist/index.js')))
const { CodexProvider } = await import(pathToFileURL(join(repo, 'packages/providers/openai/dist/index.js')))
let parentLaunched = false
let serial = 0
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
ProviderRegistry.create = () => {
  const provider = new CodexProvider({ accessToken: 'fixture', accountId: 'fixture' })
  const providerId = ++serial
  let childStep = 0
  let phase
  const script = new MockLLMProvider({ nextTurn(params, index) {
    const parent = params.tools?.some(tool => tool.function.name === 'Agent')
    const messages = JSON.stringify(params.messages)
    appendFileSync(join(root, 'requests.jsonl'), JSON.stringify({ providerId, parent, phase, at: new Date().toISOString(), messages: params.messages }) + '\n')
    if (!params.tools?.length) return { text: 'No reusable memory from this scripted UI experiment.' }
    if (parent) {
      if (!parentLaunched) {
        parentLaunched = true
        return { toolCalls: [{ id: 'native_child_launch', name: 'Agent', args: {
          description: 'Native child continuity', prompt: 'INITIAL_CHILD_TASK_719', role: 'A careful evidence reporter.', run_in_background: false,
        } }] }
      }
      if (messages.includes('FOLLOWUP_CORRECTED_FINAL_719')) return { text: 'PARENT_FOLLOWUP_REPORT_SEEN_719' }
      if (messages.includes('CHILD_CORRECTED_FINAL_719')) return { text: 'PARENT_ASSIGNMENT_AND_RESULT_SEEN_719' }
      const launched = params.messages.find(message => message.role === 'tool' && message.toolCallId === 'native_child_launch')
      const task = String(launched?.content).match(/as task ([0-9a-f-]{36})/)?.[1]
      if (!task) throw new Error('Native child task receipt missing.')
      return { toolCalls: [{ id: `native_child_wait_${index}`, name: 'wait_for_task', args: { task_id: task } }] }
    }
    if (!phase) {
      const last = params.messages.filter(message => message.role === 'user' && !message.source).at(-1)
      phase = String(last?.content).includes('DIRECT_IDLE_FOLLOWUP') ? 'second' : 'first'
    }
    if (childStep++ === 0) return { toolCalls: [{ id: `held_${phase}_${providerId}`, name: 'bash', args: {
      command: `node ${quote(join(root, 'held-tool.mjs'))} ${quote(phase)}`,
    } }] }
    if (phase === 'second') return { text: messages.includes('FOLLOWUP_BUSY_CORRECTION_719') ? 'FOLLOWUP_CORRECTED_FINAL_719' : 'FOLLOWUP_UNCORRECTED_719' }
    return { text: messages.includes('DIRECT_BUSY_CORRECTION_719') ? 'CHILD_CORRECTED_FINAL_719' : 'CHILD_UNCORRECTED_719' }
  } })
  provider.chatStream = params => script.chatStream(params)
  provider.listModels = async () => [{ id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' }]
  return { provider, capabilities: provider.capabilities }
}

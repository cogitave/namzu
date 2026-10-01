// Scripted provider transport; real CLI, registry, persistent HTTP server and PTY.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const repo = process.env.NAMZU_CHILD_FIXTURE_REPO
const root = process.env.NAMZU_CHILD_FIXTURE_ROOT
if (!repo || !root) throw new Error('Set the owned fixture repo and scratch root.')
const { ProviderRegistry, MockLLMProvider } = await import(pathToFileURL(join(repo, 'packages/sdk/dist/index.js')))
const { CodexProvider } = await import(pathToFileURL(join(repo, 'packages/providers/openai/dist/index.js')))
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
ProviderRegistry.create = () => {
  const provider = new CodexProvider({ accessToken: 'fixture', accountId: 'fixture' })
  const script = new MockLLMProvider({ nextTurn(params) {
    appendFileSync(join(root, 'requests.jsonl'), JSON.stringify({ at: new Date().toISOString(), messages: params.messages }) + '\n')
    if (!params.tools?.length) return { text: 'No reusable memory from this scripted UI experiment.' }
    const result = id => params.messages.find(message => message.role === 'tool' && message.toolCallId === id)
    if (!result('launch_native_server')) return { toolCalls: [{ id: 'launch_native_server', name: 'bash', args: {
      command: `node ${quote(join(root, 'server.mjs'))}`, run_in_background: true,
    } }] }
    if (!result('wait_native_readiness')) {
      const id = String(result('launch_native_server').content).match(/Started background job ([^.\s]+)/)?.[1]
      if (!id) throw new Error('Owned native job id missing.')
      writeFileSync(join(root, 'wait-requested'), id)
      return { toolCalls: [{ id: 'wait_native_readiness', name: 'wait_for_job', args: {
        id, output_contains: 'READY_719', output_stream: 'stdout', timeout_ms: 120000, idle_timeout_ms: 120000,
      } }] }
    }
    if (!result('verify_native_http')) {
      if (!String(result('wait_native_readiness').content).includes('Output marker observed on stdout')) throw new Error('Readiness was not matched.')
      return { toolCalls: [{ id: 'verify_native_http', name: 'bash', args: {
        command: `node ${quote(join(root, 'check-server.mjs'))}`,
      } }] }
    }
    if (!String(result('verify_native_http').content).includes('NATIVE_HTTP_OK_719')) throw new Error('HTTP check failed.')
    return { text: 'NATIVE_READY_AND_HTTP_SEEN_719' }
  } })
  provider.chatStream = params => script.chatStream(params)
  provider.listModels = async () => [{ id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' }]
  return { provider, capabilities: provider.capabilities }
}

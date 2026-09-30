/** Real CLI and kernel; only model/network I/O is replaced for native UI regression. */
import { appendFileSync } from 'node:fs'
import { MockLLMProvider, ProviderRegistry } from '../../../packages/sdk/dist/index.js'
let mainTurn = 0
const turns = [
	{ toolCalls: [{ id: 'native-call-1', name: 'bash', args: { command: 'printf DESKTOP_PIPE_OK' } }] },
	{ text: 'Native runtime answered. DESKTOP_PIPE_OK\n\nThe foreground command completed successfully.\n\n- Ran the command in the selected project.\n- Captured its output in this conversation.\n\nYou can continue here while I work on the next step.' },
	{ toolCalls: [{ id: 'native-job-1', name: 'bash', args: { command: `${JSON.stringify(process.execPath)} -e "console.log('BACKGROUND_PIPE_OK');setInterval(()=>{},1000)"`, run_in_background: true } }] },
	{ text: 'The background process is running.\n\nOpen **Background work** to read the output or stop the process.\n\n```text\nBACKGROUND_PIPE_OK\n```\n\nThe process belongs to this conversation.' },
	{ toolCalls: [{ id: 'native-file-1', name: 'write', args: { path: 'src/session.ts', content: `export interface Session {\n  id: string\n  title: string\n  status: 'idle' | 'working'\n}\n\nexport function createSession(id: string): Session {\n  return { id, title: 'New conversation', status: 'idle' }\n}\n` } }] },
	{ text: 'Created **src/session.ts** in this project.\n\nThe session now carries its own title and execution status.\n\n- Added the session type.\n- Kept the initial status idle.\n- Changes are available in the diff panel.\n\nThe background process has been stopped.' },
]
const provider = new MockLLMProvider({ nextTurn: (request) => {
	if (!request.tools?.some((tool) => tool.function.name === 'bash')) {
		return { text: JSON.stringify({ mode: 'direct', time: 'unspecified', termIds: [], focusIds: [], basis: [] }) }
	}
	return turns[mainTurn++] ?? { text: 'Fixture complete.' }
}, onRequest: (request) => {
	appendFileSync(process.env.NAMZU_TEST_RECEIPTS, `${JSON.stringify({ model: request.model, roles: request.messages.map((message) => message.role), purpose: request.tools?.some((tool) => tool.function.name === 'bash') ? 'agent' : 'evidence-query' })}\n`)
} })
ProviderRegistry.createProvider = () => provider
ProviderRegistry.createProviderAsync = async () => provider
globalThis.fetch = async () => { throw new Error('External network is forbidden in the native regression.') }
await import('../../../packages/cli/dist/bin.js')

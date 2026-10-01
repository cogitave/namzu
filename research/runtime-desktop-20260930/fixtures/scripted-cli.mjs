/** Real CLI and kernel; only model/network I/O is replaced for native UI regression. */
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { MockLLMProvider, ProviderRegistry } from '../../../packages/sdk/dist/index.js'
let mainTurn = 0
const handled = new Set()
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
	if (process.env.NAMZU_TEST_COMPOSER === '1') {
		const authored = request.messages.filter((message) => message.role === 'user' && !message.source).at(-1)
		const text = typeof authored?.content === 'string' ? authored.content : ''
		if (text.includes('Fail composer provider once') && !handled.has(text)) {
			handled.add(text)
			throw new Error('COMPOSER_PROVIDER_FAILURE_FOR_RETRY')
		}
		if (text.includes('Hold composer turn') && !handled.has(text)) {
			handled.add(text)
			return { toolCalls: [{ id: `composer-hold-${handled.size}`, name: 'bash', args: { command: 'printf COMPOSER_QUEUE_OK' } }] }
		}
		if ((text.includes('Run planned file change') || text.includes('Run allowed file change')) && !handled.has(text)) {
			handled.add(text)
			return { toolCalls: [{ id: `composer-file-${handled.size}`, name: 'write', args: { path: 'composer-fixture.txt', content: 'COMPOSER_PERMISSION_OK' } }] }
		}
		return { text: 'Composer fixture answered.' }
	}
	return turns[mainTurn++] ?? { text: 'Fixture complete.' }
}, onRequest: (request) => {
	appendFileSync(process.env.NAMZU_TEST_RECEIPTS, `${JSON.stringify({ model: request.model, roles: request.messages.map((message) => message.role), purpose: request.tools?.some((tool) => tool.function.name === 'bash') ? 'agent' : 'evidence-query', ...(request.effort ? { effort: request.effort } : {}), users: request.messages.filter((message) => message.role === 'user' && !message.source).map((message) => ({ text: typeof message.content === 'string' ? message.content : '[Media message]', attachments: (message.attachments ?? []).map((attachment) => ({ type: attachment.type, mediaType: attachment.mediaType, ...(typeof attachment.data === 'string' ? { bytes: Buffer.byteLength(attachment.data, 'base64'), sha256: createHash('sha256').update(Buffer.from(attachment.data, 'base64')).digest('hex') } : {}) })) })) })}\n`)
} })
// The actual listing path projects a scripted driver catalogue; no external I/O.
provider.listModels = async () => [
 { id:'claude-opus-4-7',name:'Fixture Opus',contextWindow:200000,maxOutputTokens:8192 },
 { id:'claude-sonnet-4-5',name:'Fixture Sonnet',contextWindow:200000,maxOutputTokens:8192 },
]
if (process.env.NAMZU_TEST_COMPOSER === '1') {
	provider.reasoningEffortLevelsFor = () => ['low', 'high']
	provider.reasoningEffortDefaultFor = () => 'low'
}
ProviderRegistry.createProvider = () => provider
ProviderRegistry.createProviderAsync = async () => provider
globalThis.fetch = async () => { throw new Error('External network is forbidden in the native regression.') }
await import('../../../packages/cli/dist/bin.js')

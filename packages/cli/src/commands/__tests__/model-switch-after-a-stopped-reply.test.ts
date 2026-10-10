import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
	type ScriptedService,
	chatService,
	messagesService,
} from './support/scripted-wire-servers.js'

/**
 * The owner's flow, on the real binary over real pipes (`namzu acp --desktop`, the process the
 * desktop application spawns) and two local scripted services: a conversation starts on one model, the
 * first reply stops on a rate limit, the model is switched to gpt-6-luna, and the conversation must
 * go on, either by sending a new message or by Try again. Nothing here waits on a clock: the test
 * awaits the frames the process writes, and the test runner's own timeout catches a real hang.
 */
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'bin.js')

interface Frame {
	id?: number
	method?: string
	params?: Record<string, any>
	result?: Record<string, any>
	error?: { code: number; message: string }
}

class Wire {
	readonly frames: Frame[] = []
	stderr = ''
	private buffer = ''
	private next = 0
	private watchers = new Set<() => void>()
	private ended = false

	constructor(readonly child: ChildProcessWithoutNullStreams) {
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', (chunk: string) => {
			this.buffer += chunk
			for (let at = this.buffer.indexOf('\n'); at !== -1; at = this.buffer.indexOf('\n')) {
				const line = this.buffer.slice(0, at)
				this.buffer = this.buffer.slice(at + 1)
				try {
					this.frames.push(JSON.parse(line) as Frame)
				} catch {
					/* Not protocol. */
				}
			}
			for (const wake of [...this.watchers]) wake()
		})
		child.stderr.on('data', (chunk: string) => {
			this.stderr += chunk
		})
		child.once('exit', () => {
			this.ended = true
			for (const wake of [...this.watchers]) wake()
		})
	}

	async until<T>(find: () => T | undefined): Promise<T> {
		for (;;) {
			const found = find()
			if (found !== undefined) return found
			if (this.ended) throw new Error(`The host exited. stderr:\n${this.stderr}`)
			await new Promise<void>((resolve) => {
				const wake = () => {
					this.watchers.delete(wake)
					resolve()
				}
				this.watchers.add(wake)
			})
		}
	}

	async request(method: string, params: Record<string, unknown> = {}) {
		const id = ++this.next
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
		// A prompt may ask for approval; nothing here uses a tool, so no request comes back.
		const frame = await this.until(() => this.frames.find((candidate) => candidate.id === id))
		if (frame.error) throw new Error(frame.error.message)
		return frame.result ?? {}
	}
}

let dir: string
let wire: Wire | undefined
let messagesWire: ScriptedService | undefined
let chatWire: ScriptedService | undefined
afterEach(async () => {
	wire?.child.kill()
	await messagesWire?.close()
	await chatWire?.close()
	wire = messagesWire = chatWire = undefined
	rmSync(dir, { recursive: true, force: true })
})

async function start() {
	dir = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-model-switch-')))
	const home = join(dir, 'home')
	const project = join(dir, 'project')
	mkdirSync(home)
	mkdirSync(join(project, '.git'), { recursive: true })
	writeFileSync(join(project, 'namzu.config.json'), JSON.stringify({ sandbox: { enabled: false } }))
	writeFileSync(join(home, 'trust.json'), JSON.stringify({ version: 1, trusted: [project] }))
	writeFileSync(
		join(home, 'preferences.json'),
		JSON.stringify({
			version: 3,
			providers: [{ id: 'anthropic', model: 'claude-sonnet-5-5' }],
			subagents: { active: [] },
		}),
	)
	messagesWire = await messagesService([{ status: 429 }])
	chatWire = await chatService([{ text: 'Luna answers.' }])
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined && !/^(WSL_|ANTHROPIC_|OPENAI_|OPENCODE_|NAMZU_)/.test(key))
			env[key] = value
	const child = spawn(process.execPath, [BIN, 'acp', '--desktop'], {
		cwd: project,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...env,
			HOME: join(dir, 'os-home'),
			USERPROFILE: join(dir, 'os-home'),
			NAMZU_HOME: home,
			NAMZU_MODEL_CATALOGUE_REFRESH: '0',
			ANTHROPIC_API_KEY: 'not-a-secret-anthropic',
			ANTHROPIC_BASE_URL: messagesWire.url,
			OPENAI_API_KEY: 'not-a-secret-openai',
			OPENAI_BASE_URL: `${chatWire.url}/v1`,
		},
	})
	wire = new Wire(child)
	await wire.request('initialize', { protocolVersion: 1, capabilities: ['permission'] })
	return { wire, project }
}

const lastText = (request: Record<string, any>): string => {
	const users = (request.messages as Record<string, any>[]).filter((m) => m.role === 'user')
	const parts = users.map((m) =>
		typeof m.content === 'string'
			? m.content
			: (m.content as { text?: string }[]).map((part) => part.text ?? '').join(''),
	)
	return parts.filter((text) => text && !text.startsWith('Current step context')).at(-1) ?? ''
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')(
	'a reply that stopped on a rate limit, then a model change, on the real binary',
	() => {
		it('goes on when a new message is sent after switching to gpt-6-luna', async () => {
			const { wire, project } = await start()
			const { sessionId } = await wire.request('session/new', { cwd: project })
			const stopped = await wire.request('session/prompt', {
				sessionId,
				prompt: 'hello there',
				options: { permissionMode: 'prompt' },
			})
			expect(stopped.stopReason).not.toBe('end_turn')
			expect(await wire.request('namzu/sessions/retry-status', { sessionId })).toMatchObject({
				retry: { original: { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
				closable: true,
			})

			await wire.request('namzu/providers/select', {
				sessionId,
				provider: 'openai',
				model: 'gpt-6-luna',
			})
			// What the owner met: with the model changed the stopped reply still has to be closable.
			expect(await wire.request('namzu/sessions/retry-status', { sessionId })).toMatchObject({
				closable: true,
			})
			expect(await wire.request('namzu/sessions/abandon-paused', { sessionId })).toEqual({
				closed: true,
			})
			expect(await wire.request('namzu/sessions/retry-status', { sessionId })).toEqual({})

			const answered = await wire.request('session/prompt', {
				sessionId,
				prompt: 'hello again',
				options: { permissionMode: 'prompt' },
			})
			expect(answered.stopReason).toBe('end_turn')
			const sent = chatWire?.requests.at(-1) as Record<string, any>
			expect(sent.model).toBe('gpt-6-luna')
			expect(lastText(sent)).toBe('hello again')
		}, 60_000)

		it('repeats the stopped reply on gpt-6-luna when Try again is pressed after switching', async () => {
			const { wire, project } = await start()
			const { sessionId } = await wire.request('session/new', { cwd: project })
			await wire.request('session/prompt', {
				sessionId,
				prompt: 'hello there',
				options: { permissionMode: 'prompt' },
			})
			const { retry } = await wire.request('namzu/sessions/retry-status', { sessionId })
			expect(retry).toMatchObject({ original: { provider: 'anthropic' } })
			const firstWireRequests = messagesWire?.requests.length

			await wire.request('namzu/providers/select', {
				sessionId,
				provider: 'openai',
				model: 'gpt-6-luna',
			})
			// The settings the turn began under survive the change, so Try again is still offered.
			expect(await wire.request('namzu/sessions/retry-status', { sessionId })).toMatchObject({
				retry: { turnId: retry?.turnId, checkpointId: retry?.checkpointId },
			})
			const repeated = await wire.request('namzu/sessions/retry', {
				sessionId,
				turnId: retry?.turnId,
				checkpointId: retry?.checkpointId,
			})
			expect(repeated.stopReason).toBe('end_turn')
			expect(messagesWire?.requests.length).toBe(firstWireRequests)
			const sent = chatWire?.requests.at(-1) as Record<string, any>
			expect(sent.model).toBe('gpt-6-luna')
			expect(lastText(sent)).toBe('hello there')
		}, 60_000)
	},
)

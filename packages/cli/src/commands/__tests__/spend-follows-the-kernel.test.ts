import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The spend view against logs the real kernel wrote, not logs made by hand.
 *
 * One `namzu acp --desktop` process takes three turns of one conversation, the second using
 * more than everything before it and the third less, then the process ends and a second one
 * continues the same conversation for a fourth turn (`session/load`). A local scripted service
 * answers every model request and writes down the usage it reported. The view's total for the
 * conversation must equal that sum, to the token.
 *
 * What it guards: the figures a turn records are that turn's own, whichever turn it is. A rule
 * that read a turn as a running total because its first figure was at least the settled figure
 * of the turn before would count the second and the fourth turn short here.
 *
 * Nothing waits on a clock: the test awaits the frames the process writes, and the runner's
 * own timeout catches a real hang.
 */
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'bin.js')

/** What the service reports for a request, by the turn marker in the prompt: [input, output]. */
const USAGE: Record<string, readonly [number, number]> = {
	T1: [1000, 200],
	T2: [3000, 500],
	T3: [400, 50],
	T4: [600, 80],
}
/** Any request the kernel makes for itself, with no marker in sight. */
const OTHER: readonly [number, number] = [7, 3]

interface Reported {
	readonly input: number
	readonly output: number
}

async function usageService(): Promise<{
	url: string
	reported: Reported[]
	close: () => Promise<void>
}> {
	const reported: Reported[] = []
	const server: Server = createServer((req, res) => {
		let body = ''
		req.on('data', (chunk) => {
			body += chunk
		})
		req.on('end', () => {
			if (!req.url?.includes('/messages')) {
				res.writeHead(404).end('{}')
				return
			}
			const request = JSON.parse(body) as { model?: string; messages?: unknown }
			const marks = [...JSON.stringify(request.messages ?? []).matchAll(/MARK(T\d)/g)]
			const tag = marks.at(-1)?.[1]
			const [input, output] = (tag === undefined ? undefined : USAGE[tag]) ?? OTHER
			reported.push({ input, output })
			res.writeHead(200, { 'content-type': 'text/event-stream' })
			const send = (type: string, data: object) =>
				res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
			send('message_start', {
				message: {
					id: 'msg',
					type: 'message',
					role: 'assistant',
					model: request.model,
					content: [],
					stop_reason: null,
					usage: { input_tokens: input, output_tokens: 1 },
				},
			})
			send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
			send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
			send('content_block_stop', { index: 0 })
			send('message_delta', {
				delta: { stop_reason: 'end_turn', stop_sequence: null },
				usage: { output_tokens: output },
			})
			send('message_stop', {})
			res.end()
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		reported,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}

interface Frame {
	id?: number
	result?: Record<string, any>
	error?: { message: string }
}

class Host {
	readonly frames: Frame[] = []
	stderr = ''
	private buffer = ''
	private next = 0
	private ended = false
	private watchers = new Set<() => void>()

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

	async request(method: string, params: Record<string, unknown> = {}) {
		const id = ++this.next
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
		for (;;) {
			const frame = this.frames.find((candidate) => candidate.id === id)
			if (frame) {
				if (frame.error) throw new Error(frame.error.message)
				return frame.result ?? {}
			}
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

	async stop() {
		if (this.ended) return
		const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
		this.child.kill()
		await exited
	}
}

let dir: string
const hosts: Host[] = []
let service: Awaited<ReturnType<typeof usageService>> | undefined
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop()
	await service?.close()
	service = undefined
	rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')(
	'the spend view on a conversation the real kernel recorded over several turns and processes',
	() => {
		it('adds up to what the provider reported, to the token', async () => {
			dir = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-spend-kernel-')))
			const home = join(dir, 'home')
			const project = join(dir, 'project')
			mkdirSync(home)
			mkdirSync(join(project, '.git'), { recursive: true })
			writeFileSync(
				join(project, 'namzu.config.json'),
				JSON.stringify({ sandbox: { enabled: false } }),
			)
			writeFileSync(join(home, 'trust.json'), JSON.stringify({ version: 1, trusted: [project] }))
			writeFileSync(
				join(home, 'preferences.json'),
				JSON.stringify({
					version: 3,
					providers: [{ id: 'anthropic', model: 'claude-sonnet-5-5' }],
					subagents: { active: [] },
				}),
			)
			service = await usageService()
			const env: Record<string, string> = {}
			for (const [key, value] of Object.entries(process.env))
				if (value !== undefined && !/^(WSL_|ANTHROPIC_|OPENAI_|OPENCODE_|NAMZU_)/.test(key))
					env[key] = value
			const hostEnv = {
				...env,
				HOME: join(dir, 'os-home'),
				USERPROFILE: join(dir, 'os-home'),
				NAMZU_HOME: home,
				NAMZU_MODEL_CATALOGUE_REFRESH: '0',
				ANTHROPIC_API_KEY: 'not-a-secret-anthropic',
				ANTHROPIC_BASE_URL: service.url,
			}
			const start = async () => {
				const host = new Host(
					spawn(process.execPath, [BIN, 'acp', '--desktop'], {
						cwd: project,
						stdio: ['pipe', 'pipe', 'pipe'],
						env: hostEnv,
					}),
				)
				hosts.push(host)
				await host.request('initialize', { protocolVersion: 1, capabilities: ['permission'] })
				return host
			}
			const prompt = async (host: Host, sessionId: string, mark: string) => {
				const answered = await host.request('session/prompt', {
					sessionId,
					prompt: `hello MARK${mark}`,
					options: { permissionMode: 'prompt' },
				})
				expect(answered.stopReason).toBe('end_turn')
			}

			// Three turns in one process.
			const first = await start()
			const { sessionId } = await first.request('session/new', { cwd: project })
			for (const mark of ['T1', 'T2', 'T3']) await prompt(first, sessionId, mark)
			await first.stop()
			// The same conversation, continued in a new process.
			const second = await start()
			await second.request('session/load', { sessionId, cwd: project })
			await prompt(second, sessionId, 'T4')
			await second.stop()

			// What the kernel wrote.
			const logs = findLogs(home)
			expect(logs).toHaveLength(1)
			const settled = readFileSync(logs[0] as string, 'utf8')
				.split('\n')
				.filter((line) => line.includes('"type":"turn_completed"'))
				.map((line) => (JSON.parse(line) as { settlement: { usage: Usage } }).settlement.usage)
			expect(settled).toHaveLength(4)
			// The shape the guard is about: a later turn that spent more than everything before it
			// in every count, one that spent less, and the first turn of the new process.
			const at = (i: number) => settled[i] as Usage
			expect(at(1).totalTokens).toBeGreaterThan(at(0).totalTokens)
			expect(at(1).promptTokens).toBeGreaterThanOrEqual(at(0).promptTokens)
			expect(at(1).completionTokens).toBeGreaterThanOrEqual(at(0).completionTokens)
			expect(at(2).totalTokens).toBeLessThan(at(1).totalTokens)
			expect(at(3).totalTokens).toBeGreaterThan(at(2).totalTokens)

			const providerTotal = service.reported.reduce((n, r) => n + r.input + r.output, 0)
			const settledTotal = settled.reduce((n, u) => n + u.totalTokens, 0)
			// Every request fell inside a turn, so the log holds exactly what the provider reported.
			expect(settledTotal).toBe(providerTotal)

			const printed = execFileSync(process.execPath, [BIN, 'cost', '--json', '--days', '30'], {
				cwd: project,
				env: hostEnv,
				encoding: 'utf8',
			})
			const report = JSON.parse(printed) as {
				totals: { tokens: number; conversations: number; outputTokens: number }
			}
			expect(report.totals.conversations).toBe(1)
			expect(report.totals.tokens).toBe(providerTotal)
			expect(report.totals.outputTokens).toBe(service.reported.reduce((n, r) => n + r.output, 0))
		}, 120_000)
	},
)

interface Usage {
	totalTokens: number
	promptTokens: number
	completionTokens: number
}

function findLogs(home: string): string[] {
	const found: string[] = []
	const root = join(home, 'projects')
	const walk = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name)
			if (entry.isDirectory()) walk(full)
			else if (entry.name.endsWith('.jsonl')) found.push(full)
		}
	}
	walk(root)
	return found
}

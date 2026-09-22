import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	DiskSessionLog,
	type SessionId,
	type TurnId,
	abandonTurn,
	asSessionId,
	generateMessageId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'

/**
 * A `run` or `run-stream` stopped by a signal gives its conversation back.
 *
 * A turn holds its conversation's writer lease for as long as it runs, and
 * the lease lives for five minutes between renewals. A process terminated
 * mid-turn used to leave that lease live, so `/abandon`, `/resume` and the
 * next prompt were refused ("leased by a live writer") for up to five minutes
 * although nothing was writing. The real binary, a real signal, and a
 * provider that never answers, so the turn is certainly mid-flight when the
 * signal lands.
 */

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'bin.js')

const roots: string[] = []
const children: ChildProcess[] = []
const servers: Server[] = []
afterEach(() => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
	for (const server of servers.splice(0)) server.close()
	for (const root of roots.splice(0)) removeTempDir(root)
})

/** A chat-completions endpoint that lists one model and never answers a completion. */
async function silentProvider(): Promise<{ url: string; completions: () => number }> {
	let completions = 0
	const server = createServer((req, res) => {
		req.resume()
		if (req.method === 'GET') {
			res.setHeader('content-type', 'application/json')
			res.end(
				JSON.stringify({
					object: 'list',
					data: [{ id: 'gpt-4o', object: 'model', created: 0, owned_by: 'test' }],
				}),
			)
			return
		}
		completions += 1
		// Never answered: the turn stays mid-request until the process stops.
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('no port')
	return { url: `http://127.0.0.1:${address.port}/v1`, completions: () => completions }
}

interface Launched {
	readonly child: ChildProcess
	readonly home: string
	readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	readonly stdout: () => string
	readonly stderr: () => string
}

function launch(command: 'run' | 'run-stream', providerUrl: string): Launched {
	const root = mkdtempSync(join(realpathSync(tmpdir()), 'namzu-terminated-run-'))
	roots.push(root)
	const home = join(root, 'home')
	const work = join(root, 'work')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(work)
	const child = spawn(
		process.execPath,
		[
			CLI_BIN,
			command,
			'--trust',
			'--provider',
			'openai',
			'--model',
			'gpt-4o',
			'--cwd',
			work,
			// A keyed conversation, so run-stream records its turn durably.
			...(command === 'run-stream' ? ['--session', 'signal-test'] : []),
			'hi',
		],
		{
			env: {
				PATH: process.env.PATH ?? '',
				HOME: home,
				NAMZU_HOME: join(home, '.namzu'),
				NAMZU_LOG_LEVEL: 'silent',
				OPENAI_API_KEY: 'sk-test',
				OPENAI_BASE_URL: providerUrl,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	)
	children.push(child)
	let out = ''
	let err = ''
	child.stdout?.on('data', (chunk) => {
		out += chunk
	})
	child.stderr?.on('data', (chunk) => {
		err += chunk
	})
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on('exit', (code, signal) => resolve({ code, signal }))
	})
	return { child, home, exit, stdout: () => out, stderr: () => err }
}

async function until(condition: () => boolean, what: string, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

/** The one conversation the child started, and its log. */
function conversation(home: string): { sessionId: SessionId; log: DiskSessionLog } {
	const projects = join(home, '.namzu', 'projects')
	const [slug] = readdirSync(projects)
	if (slug === undefined) throw new Error('no project')
	const file = readdirSync(join(projects, slug)).find((name) => name.endsWith('.jsonl'))
	if (file === undefined) throw new Error('no session log')
	const sessionId = asSessionId(file.slice(0, -'.jsonl'.length))
	const dir = join(projects, slug)
	return {
		sessionId,
		log: new DiskSessionLog({
			sessionId,
			file: join(dir, file),
			sessionDir: join(dir, sessionId),
		}),
	}
}

async function activeTurnId(log: DiskSessionLog): Promise<TurnId> {
	const active = await log.activeTurn()
	if (active === null) throw new Error('no active turn')
	return active.turnId
}

describe.each([
	['run', 'SIGTERM'],
	['run', 'SIGHUP'],
	['run-stream', 'SIGTERM'],
] as const)('`namzu %s` stopped by %s', (command, signal) => {
	it('exits by the signal and leaves the turn interrupted, so /abandon works at once', async () => {
		const provider = await silentProvider()
		const run = launch(command, provider.url)
		await until(() => provider.completions() > 0, 'the completion request')
		const { sessionId, log } = conversation(run.home)
		expect((await log.activeTurn())?.state).toBe('running')
		const turnId = await activeTurnId(log)

		run.child.kill(signal)
		const exit = await run.exit
		// Death by the signal it was sent, as a supervisor expects, not an
		// ordinary failure exit.
		expect(exit.signal ?? exit.code).toBe(signal)

		// Immediately: no lease wait. The turn is interrupted, not closed —
		// nothing was appended for it by the process that died.
		expect((await log.activeTurn())?.state).toBe('interrupted')
		const types = (await log.readAll()).entries.map((entry) => entry.record.type)
		expect(types).not.toContain('turn_failed')
		expect(types).not.toContain('turn_completed')
		await abandonTurn(sessionId, turnId, 'test: abandoned after the signal', { log })
		expect((await log.activeTurn()) === null).toBe(true)

		if (command === 'run-stream') {
			// The host reading the stream is told, in band, why it ended.
			const events = run
				.stdout()
				.split('\n')
				.filter((line) => line.trim() !== '')
				.map((line) => JSON.parse(line) as { kind: string; code?: string })
			expect(events.at(-2)).toMatchObject({ kind: 'error', code: 'terminated' })
			expect(events.at(-1)).toMatchObject({ kind: 'done', sessionId })
		}
	}, 60_000)
})

describe('a new prompt after a terminated run', () => {
	it('begins at once, closing the interrupted turn as turn_failed{interrupted}', async () => {
		const provider = await silentProvider()
		const run = launch('run', provider.url)
		await until(() => provider.completions() > 0, 'the completion request')
		const { log } = conversation(run.home)
		const interrupted = await activeTurnId(log)
		run.child.kill('SIGTERM')
		await run.exit

		const lease = await log.claim({ holder: 'next-prompt', ttlMs: 60_000 })
		if (lease === null) throw new Error('the conversation is still leased')
		await log.beginTurn(
			lease,
			{
				turnId: generateTurnId(),
				userMessageId: generateMessageId(),
				config: { model: 'gpt-4o', tokenBudget: 10_000, timeoutMs: 60_000 },
			},
			{ abandonInterrupted: true },
		)
		const failed = (await log.readAll()).entries
			.map((entry) => entry.record)
			.find((record) => record.type === 'turn_failed')
		expect(failed).toMatchObject({ turnId: interrupted, failure: { code: 'interrupted' } })
		await log.release(lease)
	}, 60_000)
})

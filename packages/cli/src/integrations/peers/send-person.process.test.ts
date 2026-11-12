import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
	type SessionRecordDraft,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { LogWriter, SLUG, logHome } from '../subagents/__fixtures__/session-logs.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

const BIN = fileURLToPath(new URL('../../../dist/bin.js', import.meta.url))
const SESSION = fileURLToPath(new URL('./__fixtures__/live-session.ts', import.meta.url))

/** What one child process says, line by line, and a way to wait for a line without a clock. */
function lines(child: ReturnType<typeof spawn>) {
	const said: string[] = []
	const wakers: Array<() => void> = []
	if (child.stdout)
		createInterface({ input: child.stdout }).on('line', (line) => {
			said.push(line)
			for (const wake of wakers.splice(0)) wake()
		})
	return {
		said,
		async saw(line: string): Promise<void> {
			while (!said.includes(line)) await new Promise<void>((resolve) => wakers.push(resolve))
		},
	}
}

function run(args: string[], env: NodeJS.ProcessEnv) {
	const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
	let out = ''
	child.stdout.on('data', (chunk: Buffer) => {
		out += chunk.toString('utf8')
	})
	const done = new Promise<{ code: number | null; out: string }>((resolve) => {
		child.on('close', (code) => resolve({ code, out }))
	})
	return { child, done }
}

function fingerprint(files: string[]): Record<string, string> {
	const out: Record<string, string> = {}
	for (const path of files) {
		const s = statSync(path)
		out[path] =
			`${s.size}:${s.mtimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
	}
	return out
}

it('a real sender process reaches a real session process: accepted, delivered when taken, and finished means unreachable', async () => {
	const h = await logHome()
	roots.push(h.root)
	mkdirSync(h.paths.projectDir(), { recursive: true })
	writeFileSync(
		h.paths.projectFile(),
		JSON.stringify({
			v: 1,
			kind: 'project',
			projectId: h.projectId,
			cwd: '/work/replay',
			slug: SLUG,
			createdAt: new Date(0).toISOString(),
		}),
	)
	const tenantId = generateTenantId()
	writeFileSync(
		join(h.home, 'identity.json'),
		JSON.stringify({ tenantId, createdAt: new Date(0).toISOString() }),
	)
	const sessionId = generateSessionId()
	const writer = await LogWriter.open(h.paths, { sessionId })
	await writer.append({
		type: 'session_started',
		projectId: h.projectId,
		tenantId,
		cwd: '/work/replay',
		agent: { id: 'namzu', name: 'namzu' },
	} as SessionRecordDraft)
	const turnId = generateTurnId()
	await writer.beginTurn(turnId, 'Check the release')

	const env = { ...process.env, NAMZU_HOME: h.home, NO_COLOR: '1' }
	const session = spawn(process.execPath, ['--import', 'tsx', SESSION, h.home, h.root, sessionId], {
		env,
		stdio: ['pipe', 'pipe', 'inherit'],
	})
	const heard = lines(session)
	try {
		await heard.saw('ready')
		const logFiles = [h.paths.sessionLog({ sessionId })]
		const dir = h.paths.sessionDir({ sessionId })
		const watched = (): Record<string, string> =>
			fingerprint([...logFiles, ...readdirSync(dir).map((name) => join(dir, name))])
		const before = watched()

		// Accepted: the process takes it into its inbox and nobody takes it out.
		const accepted = await run(['send', sessionId, '--wait', '0', '--json', 'first message'], env)
			.done
		expect(accepted.code).toBe(10)
		expect(JSON.parse(accepted.out)).toMatchObject({ status: 'accepted', sessionId })
		await heard.saw('accepted:1')

		// Delivered: the sender waits; the session process takes the inbox; only then does it say so.
		const sending = run(['send', sessionId, '--json', '/second', 'message'], env)
		await heard.saw('accepted:2')
		session.stdin.write('take\n')
		const delivered = await sending.done
		expect(delivered.code).toBe(0)
		expect(JSON.parse(delivered.out)).toMatchObject({ status: 'delivered', sessionId })
		await heard.saw('taken')
		// What the process took is what was said, as the person's, with the text whole (a slash is just text).
		expect(heard.said.filter((line) => line.startsWith('took '))).toEqual([
			`took ${JSON.stringify({ kind: 'person', text: 'first message' })}`,
			`took ${JSON.stringify({ kind: 'person', text: '/second message' })}`,
		])

		// Nothing the senders did touched the session's log or lease.
		expect(watched()).toEqual(before)

		// The terminal closes and the turn settles: nothing runs the session, so the answer is 69.
		session.stdin.write('quit\n')
		await heard.saw('closed')
		await writer.completeTurn(turnId, 'done', 1)
		const gone = await run(['send', sessionId, '--json', 'anyone?'], env).done
		expect(gone.code).toBe(69)
		expect(JSON.parse(gone.out)).toMatchObject({ status: 'unreachable' })
	} finally {
		session.kill()
	}
}, 120_000)

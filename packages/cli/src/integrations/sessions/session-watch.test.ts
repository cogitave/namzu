import { createHash } from 'node:crypto'
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	truncateSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
	type SessionId,
	type SessionRecordDraft,
	type TenantId,
	generateCheckpointId,
	generateMessageId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { exitCodeOf, parseWatchArgs, runWatch } from '../../commands/watch.js'
import {
	type LogHome,
	LogWriter,
	SLUG,
	logHome,
	settlement,
} from '../subagents/__fixtures__/session-logs.js'
import {
	SessionFollower,
	SessionNotFoundError,
	type WatchTarget,
	findSession,
	listRunningSessions,
} from './session-watch.js'
import { WatchPrinter, follow, rowsOf } from './watch-view.js'
import { ChangeWaiter } from './watch-wait.js'

const homes: LogHome[] = []
afterEach(() => {
	for (const h of homes.splice(0)) removeTempDir(h.root)
})

const tenantId: TenantId = generateTenantId()

async function fixture(): Promise<LogHome> {
	const h = await logHome()
	homes.push(h)
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
	return h
}

interface Session {
	readonly id: SessionId
	readonly writer: LogWriter
	readonly turnId: ReturnType<typeof generateTurnId>
	readonly target: WatchTarget
}

/** A session with a turn open, as a running terminal leaves it. */
async function running(h: LogHome, prompt = 'Check the release'): Promise<Session> {
	const id = generateSessionId()
	const writer = await LogWriter.open(h.paths, { sessionId: id })
	await writer.append({
		type: 'session_started',
		projectId: h.projectId,
		tenantId,
		cwd: '/work/replay',
		agent: { id: 'namzu', name: 'namzu' },
	} as SessionRecordDraft)
	const turnId = generateTurnId()
	await writer.beginTurn(turnId, prompt)
	return {
		id,
		writer,
		turnId,
		target: {
			paths: h.paths,
			projectId: h.projectId,
			sessionId: id,
			tenantId,
			folder: '/work/replay',
		},
	}
}

async function say(s: Session, text: string): Promise<void> {
	await s.writer.append({
		type: 'message',
		turnId: s.turnId,
		messageId: generateMessageId(),
		role: 'assistant',
		content: { role: 'assistant', content: text },
	} as SessionRecordDraft)
}

function texts(rows: readonly { content: string }[]): string[] {
	return rows.map((r) => r.content)
}

/** Every file under the session's folder plus its log, with size, mtime and a content hash. */
function fingerprint(h: LogHome, id: SessionId): Record<string, string> {
	const out: Record<string, string> = {}
	const add = (path: string): void => {
		const s = statSync(path)
		out[path] =
			`${s.size}:${s.mtimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
	}
	add(h.paths.sessionLog({ sessionId: id }))
	const dir = h.paths.sessionDir({ sessionId: id })
	for (const name of readdirSync(dir)) add(join(dir, name))
	return out
}

describe('SessionFollower', () => {
	it('picks up what is appended and reports nothing when nothing was', async () => {
		const h = await fixture()
		const s = await running(h)
		const follower = new SessionFollower({ target: s.target })

		const first = await follower.poll()
		expect(first.changed).toBe(true)
		expect(first.status.state).toBe('running')
		expect(texts(rowsOf(first, '/work/replay'))).toEqual(['Check the release'])

		const quiet = await follower.poll()
		expect(quiet.changed).toBe(false)
		expect(quiet.messages).toBe(first.messages)

		await say(s, 'The release looks fine.')
		const second = await follower.poll()
		expect(second.changed).toBe(true)
		expect(second.reset).toBe(false)
		expect(texts(rowsOf(second, '/work/replay'))).toEqual([
			'Check the release',
			'The release looks fine.',
		])
	})

	it('never changes the log or the lease it watches', async () => {
		const h = await fixture()
		const s = await running(h)
		await say(s, 'One step.')
		const before = fingerprint(h, s.id)
		expect(Object.keys(before).some((p) => p.endsWith('lease.json'))).toBe(true)

		const follower = new SessionFollower({ target: s.target })
		await follower.poll()
		await follower.poll()
		const out: string[] = []
		const printer = new WatchPrinter({
			write: (t) => out.push(t),
			plain: false,
			columns: 80,
			ended: 'stay',
		})
		printer.update(await follower.poll(), rowsOf(await follower.poll(), '/work/replay'))
		// A whole command run on top of it, read to the end of an ended session.
		await s.writer.completeTurn(s.turnId, 'done', 1)
		const settled = fingerprint(h, s.id)
		await runWatch({ session: s.id, exitOnEnd: true, plain: true }, io(h, { out: [] }))
		expect(fingerprint(h, s.id)).toEqual(settled)
		expect(Object.keys(settled).sort()).toEqual(Object.keys(before).sort())
	})

	it('says a turn that settled is finished, by how it ended', async () => {
		const h = await fixture()
		const done = await running(h)
		await done.writer.completeTurn(done.turnId, 'ok', 3)
		const failed = await running(h)
		await failed.writer.append({
			type: 'turn_failed',
			turnId: failed.turnId,
			error: 'boom',
			settlement: settlement('failed', 1),
		} as SessionRecordDraft)
		const stopped = await running(h)
		await stopped.writer.append({
			type: 'turn_completed',
			turnId: stopped.turnId,
			result: '',
			stopReason: 'cancelled',
			cancelCause: 'user',
			settlement: settlement('cancelled', 1),
		} as SessionRecordDraft)

		const a = (await new SessionFollower({ target: done.target }).poll()).status
		const b = (await new SessionFollower({ target: failed.target }).poll()).status
		const c = (await new SessionFollower({ target: stopped.target }).poll()).status
		expect([a.state, a.outcome, exitCodeOf(a)]).toEqual(['finished', 'completed', 0])
		expect([b.state, b.outcome, exitCodeOf(b)]).toEqual(['finished', 'failed', 1])
		expect([c.state, c.outcome, exitCodeOf(c)]).toEqual(['finished', 'cancelled', 1])
	})

	it('says a turn whose writer is gone is interrupted', async () => {
		const h = await fixture()
		const s = await running(h)
		let now = Date.now()
		const follower = new SessionFollower({ target: s.target, now: () => now })
		expect((await follower.poll()).status.state).toBe('running')
		// The fixture's lease lasts a minute; past it nobody holds the session.
		now += 61_000
		const gone = (await follower.poll()).status
		expect(gone.state).toBe('interrupted')
		expect(exitCodeOf(gone)).toBe(69)
	})

	it('shows a session waiting for an approval, in the kernel’s words, and where to answer', async () => {
		const h = await fixture()
		const s = await running(h)
		const checkpointId = generateCheckpointId()
		await s.writer.append({
			type: 'decision_requested',
			turnId: s.turnId,
			decisionId: checkpointId,
			checkpointId,
			request: {
				type: 'tool_review',
				sessionId: s.id,
				turnId: s.turnId,
				checkpointId,
				toolCalls: [{ id: 'call_1', name: 'bash', input: { command: 'ls' }, isDestructive: false }],
			},
		} as SessionRecordDraft)
		const follower = new SessionFollower({ target: s.target })
		const waiting = (await follower.poll()).status
		expect(waiting.state).toBe('waiting')
		expect(waiting.asking).toBe('approve the call to bash')
		expect(waiting.sentence).toContain('waiting for a tool call to be approved')
		expect(waiting.sentence).toContain('terminal that runs the session')

		await s.writer.append({
			type: 'decision_resolved',
			turnId: s.turnId,
			decisionId: checkpointId,
			decision: { action: 'pause', reason: 'answered' },
			resolvedBy: { kind: 'user', id: 'someone' },
		} as unknown as SessionRecordDraft)
		expect((await follower.poll()).status.state).toBe('running')
	})

	it('reads the log again from the start when it got shorter', async () => {
		const h = await fixture()
		const s = await running(h)
		await say(s, 'First.')
		await say(s, 'Second.')
		const follower = new SessionFollower({ target: s.target })
		expect((await follower.poll()).records.length).toBe(5)
		const file = h.paths.sessionLog({ sessionId: s.id })
		const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
		// What a writer's torn-tail repair or a replaced file looks like from outside.
		truncateSync(file, Buffer.byteLength(`${lines.slice(0, 4).join('\n')}\n`))
		const again = await follower.poll()
		expect(again.reset).toBe(true)
		expect(again.records.length).toBe(4)
		expect(texts(rowsOf(again, '/work/replay'))).toEqual(['Check the release', 'First.'])
	})

	it('refuses a session of another installation', async () => {
		const h = await fixture()
		const s = await running(h)
		const other = new SessionFollower({ target: { ...s.target, tenantId: generateTenantId() } })
		await expect(other.poll()).rejects.toMatchObject({ name: 'SessionNotOwnedError' })
	})
})

describe('finding sessions', () => {
	it('lists the sessions with a turn running, this folder first, and not the finished ones', async () => {
		const h = await fixture()
		const a = await running(h, 'First task')
		const b = await running(h, 'Second task')
		const done = await running(h, 'Old task')
		await done.writer.completeTurn(done.turnId, 'ok', 1)
		await done.writer.log.release(await done.writer.log.lease().then((l) => l!))
		const list = await listRunningSessions({ root: h.home, tenantId, currentSlug: SLUG })
		expect(list.map((r) => r.target.sessionId).sort()).toEqual([a.id, b.id].sort())
		expect(list.every((r) => r.here && r.state === 'running')).toBe(true)
		expect(list.map((r) => r.title)).toContain('First task')
		const elsewhere = await listRunningSessions({
			root: h.home,
			tenantId: generateTenantId(),
			currentSlug: SLUG,
		})
		expect(elsewhere).toEqual([])
	})

	it('names a session by whole id or by an unambiguous start', async () => {
		const h = await fixture()
		const a = await running(h)
		const options = { root: h.home, tenantId, currentSlug: SLUG }
		expect((await findSession(options, a.id)).sessionId).toBe(a.id)
		expect((await findSession(options, a.id.slice(0, 12))).sessionId).toBe(a.id)
		await expect(findSession(options, 'zzzzzz')).rejects.toBeInstanceOf(SessionNotFoundError)
		const b = await running(h)
		await expect(findSession(options, '0')).rejects.toThrow(/starts 2 sessions/)
		expect((await findSession(options, b.id)).sessionId).toBe(b.id)
	})
})

function io(
	h: LogHome,
	sink: { out: string[]; err?: string[] },
	over: Record<string, unknown> = {},
) {
	const controller = new AbortController()
	return {
		root: h.home,
		tenantId,
		currentSlug: SLUG,
		cwd: '/work/replay',
		write: (t: string) => void sink.out.push(t),
		writeError: (t: string) => void (sink.err ?? []).push(t),
		plain: true,
		columns: 80,
		interactive: false,
		signal: controller.signal,
		makeWaiter: () => ({ wait: async () => undefined, close: () => undefined }),
		...over,
	}
}

describe('the command', () => {
	it('prints a finished session in plain text with no terminal control, and exits by how it ended', async () => {
		const h = await fixture()
		const s = await running(h, 'Say hi')
		await say(s, 'Hi there.')
		await s.writer.completeTurn(s.turnId, 'Hi there.', 2)
		const out: string[] = []
		const code = await runWatch({ session: s.id, exitOnEnd: true, plain: true }, io(h, { out }))
		const text = out.join('')
		expect(code).toBe(0)
		expect(text).toContain('Say hi')
		expect(text).toContain('Hi there.')
		expect(text).toContain('Read-only')
		expect(text).toContain('finished')
		expect(text.includes('\u001b') || text.includes('\r')).toBe(false)
	})

	it('exits 69 for an interrupted session and 1 for a failed one', async () => {
		const h = await fixture()
		const lost = await running(h)
		const gone = await runWatch(
			{ session: lost.id, exitOnEnd: true, plain: true },
			io(h, { out: [] }, { now: () => Date.now() + 120_000 }),
		)
		expect(gone).toBe(69)
		const bad = await running(h)
		await bad.writer.append({
			type: 'turn_failed',
			turnId: bad.turnId,
			error: 'boom',
			settlement: settlement('failed', 1),
		} as SessionRecordDraft)
		expect(
			await runWatch({ session: bad.id, exitOnEnd: true, plain: true }, io(h, { out: [] })),
		).toBe(1)
	})

	it('draws text from the session through the terminal escaping', async () => {
		const h = await fixture()
		const s = await running(h, 'Hi')
		await say(s, 'red \u001b[31mtext\u001b[0m and ‮ reversed')
		await s.writer.completeTurn(s.turnId, 'x', 1)
		const out: string[] = []
		await runWatch({ session: s.id, exitOnEnd: true, plain: true }, io(h, { out }))
		const text = out.join('')
		expect(text).not.toContain('\u001b')
		expect(text).not.toContain('‮')
		expect(text).toContain('\\u{001b}[31m')
	})

	it('on a terminal keeps one status line current and says it is read-only', async () => {
		const h = await fixture()
		const s = await running(h)
		const out: string[] = []
		const controller = new AbortController()
		let waits = 0
		const code = await runWatch(
			{ session: s.id, exitOnEnd: false, plain: false },
			io(
				h,
				{ out },
				{
					plain: false,
					signal: controller.signal,
					makeWaiter: () => ({
						wait: async () => {
							waits += 1
							if (waits === 2) await say(s, 'A settled step.')
							if (waits === 3) controller.abort()
						},
						close: () => undefined,
					}),
				},
			),
		)
		const text = out.join('')
		expect(code).toBe(130)
		expect(text).toContain('watching · read-only · running')
		expect(text).toContain('A settled step.')
		expect(text).toContain('\r\u001b[2K')
		expect(text).toContain('the session was not touched')
	})

	it('stays open after a session ends unless asked to leave', async () => {
		const h = await fixture()
		const s = await running(h)
		await s.writer.completeTurn(s.turnId, 'ok', 1)
		const controller = new AbortController()
		const out: string[] = []
		let waits = 0
		const code = await runWatch(
			{ session: s.id, exitOnEnd: false, plain: true },
			io(
				h,
				{ out },
				{
					signal: controller.signal,
					makeWaiter: () => ({
						wait: async () => {
							waits += 1
							controller.abort()
						},
						close: () => undefined,
					}),
				},
			),
		)
		expect(waits).toBe(1)
		expect(code).toBe(130)
	})

	it('offers the running sessions when none is named, and refuses to guess in a pipe', async () => {
		const h = await fixture()
		await running(h, 'First task')
		await running(h, 'Second task')
		const err: string[] = []
		const code = await runWatch({ exitOnEnd: true, plain: true }, io(h, { out: [], err }))
		expect(code).toBe(64)
		expect(err.join('')).toContain('2 sessions are running; name one')
		expect(err.join('')).toContain('First task')
		const empty = await fixture()
		const none: string[] = []
		expect(
			await runWatch({ exitOnEnd: true, plain: true }, io(empty, { out: [], err: none })),
		).toBe(66)
		expect(none.join('')).toContain('No session has a turn running now')
	})

	it('draws again from the top when the session rewrote its history', async () => {
		const out: string[] = []
		const printer = new WatchPrinter({
			write: (t) => out.push(t),
			plain: true,
			columns: 80,
			ended: 'stay',
		})
		const h = await fixture()
		const s = await running(h)
		await say(s, 'First.')
		await say(s, 'Second.')
		const follower = new SessionFollower({ target: s.target })
		const one = await follower.poll()
		printer.update(one, rowsOf(one, '/work/replay'))
		const file = h.paths.sessionLog({ sessionId: s.id })
		const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
		truncateSync(file, Buffer.byteLength(`${lines.slice(0, 2).join('\n')}\n`))
		const two = await follower.poll()
		printer.update(two, rowsOf(two, '/work/replay'))
		expect(out.join('')).toContain('rewrote its history')
	})

	it('leaves the screen alone on a poll that found nothing new', async () => {
		const h = await fixture()
		const s = await running(h)
		const follower = new SessionFollower({ target: s.target })
		const out: string[] = []
		const printer = new WatchPrinter({
			write: (t) => out.push(t),
			plain: false,
			columns: 80,
			ended: 'stay',
		})
		const first = await follower.poll()
		const rows = rowsOf(first, '/work/replay')
		printer.update(first, rows)
		const written = out.length
		printer.update(await follower.poll(), rows)
		expect(out.length).toBe(written)
	})

	it('parses its arguments', () => {
		expect(parseWatchArgs(['ses_a', '--exit-on-end', '--plain'])).toEqual({
			session: 'ses_a',
			exitOnEnd: true,
			plain: true,
		})
		expect(parseWatchArgs([])).toEqual({ exitOnEnd: false, plain: false })
		expect(parseWatchArgs(['--steer'])).toEqual({ error: 'Unknown option --steer.' })
		expect(parseWatchArgs(['a', 'b'])).toEqual({ error: 'Name one session.' })
	})
})

describe('follow', () => {
	it('ends when the session ends, driven by its own wait and no clock', async () => {
		const h = await fixture()
		const s = await running(h)
		const follower = new SessionFollower({ target: s.target })
		const out: string[] = []
		const printer = new WatchPrinter({
			write: (t) => out.push(t),
			plain: true,
			columns: 80,
			ended: 'exit',
		})
		const steps = [() => say(s, 'Working.'), () => s.writer.completeTurn(s.turnId, 'ok', 1)]
		const end = await follow({
			follower,
			printer,
			cwd: '/work/replay',
			exitOnEnd: true,
			signal: new AbortController().signal,
			wait: async () => {
				await steps.shift()?.()
			},
		})
		expect(end.reason).toBe('ended')
		expect(out.join('')).toContain('Working.')
	})
})

describe('ChangeWaiter', () => {
	it('wakes on a change, on the bounded fallback, and on abort', async () => {
		vi.useFakeTimers()
		try {
			const listeners: Array<(event: string, name: string | null) => void> = []
			const waiter = new ChangeWaiter({
				targets: [{ dir: '/x', name: 'a.jsonl' }],
				fallbackMs: 1_000,
				watchDir: (_dir, listener) => {
					listeners.push(listener)
					return { on: () => undefined, close: () => undefined } as never
				},
			})
			const ac = new AbortController()
			let woke = 0
			const next = (): Promise<void> =>
				waiter.wait(ac.signal).then(() => {
					woke += 1
				})

			// A change for the watched name wakes it; another name does not.
			let p = next()
			listeners[0]?.('change', 'other.jsonl')
			await vi.advanceTimersByTimeAsync(999)
			expect(woke).toBe(0)
			listeners[0]?.('change', 'a.jsonl')
			await p
			expect(woke).toBe(1)

			// A change that came before the wait is not lost.
			listeners[0]?.('change', 'a.jsonl')
			await next()
			expect(woke).toBe(2)

			// With nothing happening, the timer bounds the wait.
			p = next()
			await vi.advanceTimersByTimeAsync(1_000)
			await p
			expect(woke).toBe(3)

			// Abort ends a wait at once.
			p = next()
			ac.abort()
			await p
			expect(woke).toBe(4)
			waiter.close()
		} finally {
			vi.useRealTimers()
		}
	})
})

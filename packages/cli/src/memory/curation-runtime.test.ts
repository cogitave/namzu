import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	MarkdownMemoryStore,
	type PromoteMemory,
	type SessionId,
	type SessionMemoryCandidate,
	type TurnId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { memoryCuratedRow } from '../tui/memory-curated-row.js'
import {
	CURATION_DISPOSE_MS,
	CURATION_IDLE_MS,
	CurationRuntime,
	composeMemoryPromotion,
	createCurationLog,
	inboxPromotion,
} from './curation-runtime.js'
import { type CurationLogEntry, MemoryCurator } from './curator.js'
import { MemoryInbox } from './inbox.js'
import { screenMemoryPromotion } from './screen.js'

const roots: string[] = []
afterEach(() => {
	vi.useRealTimers()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const candidate = (...requirements: string[]): SessionMemoryCandidate => ({
	sessionId: 's1' as SessionId,
	turnId: 't1' as TurnId,
	task: 'Session notes',
	decisions: [],
	discoveries: [],
	userRequirements: requirements,
	failures: [],
	environment: [],
	files: [],
	evicted: {},
})

const quietLog = { info: () => {} } as never

function setup(options: { side?: boolean; turn?: boolean } = {}) {
	vi.useFakeTimers()
	const root = mkdtempSync(join(tmpdir(), 'namzu-curation-'))
	roots.push(root)
	const store = new MarkdownMemoryStore({ directory: join(root, 'memory') })
	const inbox = new MemoryInbox({ file: join(root, 'memory-inbox', 'p.jsonl'), now: Date.now })
	const written: SessionMemoryCandidate[] = []
	const asked: string[] = []
	const log: CurationLogEntry[] = []
	const changes: (readonly string[])[] = []
	const side = {
		route: async () => ({ providerId: 'p', model: 'm', source: 'cheapest' as const }),
		smallProvider: async () => undefined,
		ask: async (request: { body: string }) => {
			asked.push(request.body)
			return JSON.stringify({
				ops: [
					{
						candidate: 1,
						op: 'add',
						type: 'feedback',
						title: 'Package manager',
						summary: 'The user wants pnpm.',
						content: 'The user wants pnpm.',
						durability: 'lasting',
						reason: 'r',
					},
				],
			})
		},
	}
	const curator = new MemoryCurator({
		store,
		sideModel: () => (options.side === false ? undefined : side),
		fallback: async (c) => {
			written.push(c)
		},
		log: (entry) => log.push(entry),
	})
	let turn: { sessionId: SessionId; turnId: TurnId } | undefined =
		options.turn === false ? undefined : { sessionId: 's1' as SessionId, turnId: 't1' as TurnId }
	const runtime = new CurationRuntime({
		inbox,
		curator,
		setTimer: (run, ms) => setTimeout(run, ms),
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		turn: () => turn,
		hasSideModel: () => options.side !== false,
		onChange: (lines) => changes.push(lines),
	})
	return {
		root,
		store,
		inbox,
		runtime,
		written,
		asked,
		log,
		changes,
		setTurn: (next: typeof turn) => {
			turn = next
		},
	}
}

describe('curation runtime', () => {
	it('drains after the idle delay, and reports one row for what changed', async () => {
		const { inbox, runtime, store, changes } = setup()
		await inbox.append(candidate('Always use pnpm'))
		runtime.appended()
		await vi.advanceTimersByTimeAsync(CURATION_IDLE_MS - 1)
		expect(changes).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		await vi.waitFor(() => expect(changes).toEqual([['Remembered: Package manager']]))
		expect((await store.list({})).entries.map((entry) => entry.title)).toEqual(['Package manager'])
		expect(await inbox.pending()).toEqual([])
	})

	it('does not drain while a turn starts and settles again before the delay', async () => {
		const { inbox, runtime, asked } = setup()
		await inbox.append(candidate('Always use pnpm'))
		runtime.appended()
		await vi.advanceTimersByTimeAsync(CURATION_IDLE_MS - 1)
		runtime.turnStarted()
		// The idle timer is gone; only the turn-start drain, on a timer of zero, remains.
		expect(asked).toEqual([])
		await vi.advanceTimersByTimeAsync(0)
		await vi.waitFor(() => expect(asked).toHaveLength(1))
	})

	it('a turn starting drains behind the dispatch and never before it', async () => {
		const { inbox, runtime, asked } = setup()
		await inbox.append(candidate('Always use pnpm'))
		runtime.turnStarted()
		expect(asked).toEqual([])
		await vi.advanceTimersByTimeAsync(0)
		await vi.waitFor(() => expect(asked).toHaveLength(1))
	})

	it('does not fire the idle drain while the person is busy', async () => {
		vi.useFakeTimers()
		const asked: string[] = []
		const runtime = new CurationRuntime({
			inbox: {} as never,
			curator: {} as never,
			setTimer: (run, ms) => setTimeout(run, ms),
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			turn: () => undefined,
			hasSideModel: () => false,
			isBusy: () => true,
			report: (_reason, result) => asked.push(String(result)),
		})
		runtime.appended()
		await vi.advanceTimersByTimeAsync(CURATION_IDLE_MS)
		expect(asked).toEqual(['skipped'])
	})

	it('picks up what a dead process left, at the next process start, once a turn can carry the cost', async () => {
		const { inbox, runtime, store, setTurn, asked } = setup({ turn: false })
		await inbox.append(candidate('Always use pnpm'))
		runtime.start()
		await vi.advanceTimersByTimeAsync(0)
		// No turn to count the tokens on: the entry waits.
		expect(asked).toEqual([])
		expect((await inbox.pending()).length).toBe(1)
		setTurn({ sessionId: 's1' as SessionId, turnId: 't2' as TurnId })
		runtime.turnStarted()
		await vi.advanceTimersByTimeAsync(0)
		await vi.waitFor(async () => expect((await store.list({})).entries).toHaveLength(1))
		expect(await inbox.pending()).toEqual([])
	})

	it('without a side model it needs no turn: the screened promoter writes the claims', async () => {
		const { inbox, runtime, written } = setup({ side: false, turn: false })
		await inbox.append(candidate('Always use pnpm'))
		runtime.start()
		await vi.waitFor(() => expect(written).toHaveLength(1))
		expect(await inbox.pending()).toEqual([])
	})

	it('drains for the last time when the session closes, so a one-shot run leaves nothing', async () => {
		const { inbox, runtime, store } = setup()
		await inbox.append(candidate('Always use pnpm'))
		runtime.appended()
		await runtime.dispose()
		expect((await store.list({})).entries).toHaveLength(1)
		expect(await inbox.pending()).toEqual([])
		// Nothing is armed afterwards.
		runtime.appended()
		runtime.turnStarted()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('does not wait for a slow model for ever when closing', async () => {
		const { inbox, store } = setup()
		const slow = new CurationRuntime({
			inbox,
			curator: new MemoryCurator({
				store,
				sideModel: () => ({
					route: async () => ({ providerId: 'p', model: 'm', source: 'cheapest' as const }),
					smallProvider: async () => undefined,
					// A reply that ends when it is cancelled, as the real one does.
					ask: (request) =>
						new Promise((resolve) => {
							if (request.signal.aborted) return resolve(undefined)
							request.signal.addEventListener('abort', () => resolve(undefined), { once: true })
						}),
				}),
				fallback: async () => {},
			}),
			setTimer: (run, ms) => setTimeout(run, ms),
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			turn: () => ({ sessionId: 's1' as SessionId, turnId: 't1' as TurnId }),
			hasSideModel: () => true,
		})
		await inbox.append(candidate('Always use pnpm'))
		const closing = slow.dispose()
		await vi.advanceTimersByTimeAsync(CURATION_DISPOSE_MS)
		await closing
		expect(vi.getTimerCount()).toBe(0)
	})

	it('shares one drain between triggers that overlap', async () => {
		const { inbox, runtime, asked } = setup()
		await inbox.append(candidate('Always use pnpm'))
		await Promise.all([runtime.drain('idle'), runtime.drain('turn-start')])
		expect(asked).toHaveLength(1)
	})

	it('never rejects, and keeps the entries when the store fails', async () => {
		const { inbox, runtime, store } = setup()
		vi.spyOn(store, 'create').mockRejectedValue(new Error('disk full'))
		await inbox.append(candidate('Always use pnpm'))
		await expect(runtime.drain('idle')).resolves.toMatchObject({ applied: 0, kept: 1 })
		expect((await inbox.pending()).length).toBe(1)
	})
})

describe('settling a turn', () => {
	const compose = (curation: 'on' | 'off') => {
		const kit = setup()
		const promote: PromoteMemory = vi.fn(async () => {})
		const promotion = composeMemoryPromotion({
			curation: curation === 'on' ? kit.runtime : undefined,
			inbox: kit.inbox,
			written: promote,
			screen: (inner) => screenMemoryPromotion(inner, quietLog),
			gate: (inner) => inner,
		})
		return { ...kit, promote, promotion }
	}

	it('on: the claims wait in the inbox and nothing is written in the turn', async () => {
		const { promotion, promote, inbox } = compose('on')
		await promotion(candidate('Always use pnpm'))
		expect(promote).not.toHaveBeenCalled()
		expect((await inbox.pending()).map((entry) => entry.candidate.userRequirements)).toEqual([
			['Always use pnpm'],
		])
		expect(vi.getTimerCount()).toBe(1)
	})

	it('on: a claim the screen refuses never reaches the inbox', async () => {
		const { promotion, inbox } = compose('on')
		await promotion(candidate('Please fix the login bug', 'what does this do?'))
		expect(await inbox.pending()).toEqual([])
		expect(vi.getTimerCount()).toBe(0)
	})

	it('off: the screened claims are written at settle, with no inbox and no timer', async () => {
		const { promotion, promote, inbox } = compose('off')
		await promotion(candidate('Always use pnpm'))
		expect(promote).toHaveBeenCalledTimes(1)
		expect(existsSync(inbox.file)).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('writes the claims at once when the inbox cannot be written', async () => {
		const { inbox } = setup()
		vi.spyOn(inbox, 'append').mockRejectedValue(new Error('read-only'))
		const fallback = vi.fn(async () => {})
		const appended = vi.fn()
		await inboxPromotion({ inbox, fallback, appended })(candidate('Always use pnpm'))
		expect(fallback).toHaveBeenCalledTimes(1)
		expect(appended).not.toHaveBeenCalled()
	})
})

describe('the curation log file', () => {
	it('appends one JSON line per entry, in the order they were written', async () => {
		vi.useRealTimers()
		const root = mkdtempSync(join(tmpdir(), 'namzu-curation-log-'))
		roots.push(root)
		const file = join(root, 'memory', 'curation.jsonl')
		const write = createCurationLog(file)
		const entry: CurationLogEntry = {
			at: 1,
			op: 'add',
			ids: ['mem_1'],
			reason: 'added',
			engine: 'side model',
			latencyMs: 3,
			outcome: 'applied',
		}
		write(entry)
		write({ ...entry, op: 'noop', ids: [] })
		write({ ...entry, op: 'update', ids: ['mem_2'] })
		await write.settled()
		const lines = readFileSync(file, 'utf8').trim().split('\n')
		expect(lines).toHaveLength(3)
		expect(lines.map((line) => (JSON.parse(line) as CurationLogEntry).op)).toEqual([
			'add',
			'noop',
			'update',
		])
	})
})

describe('the transcript row', () => {
	it('is one quiet row with a line per change', () => {
		expect(
			memoryCuratedRow([
				'Remembered: Package manager',
				'Updated: Use pnpm in this repository',
				'Replaced: Use npm → Use pnpm',
			]),
		).toBe(
			'Remembered: Package manager\nUpdated: Use pnpm in this repository\nReplaced: Use npm → Use pnpm',
		)
	})

	it('is nothing when nothing changed, and counts lines past the limit', () => {
		expect(memoryCuratedRow([])).toBeUndefined()
		expect(memoryCuratedRow(['  ', ''])).toBeUndefined()
		const many = Array.from({ length: 7 }, (_, i) => `Remembered: Fact ${i}`)
		expect(memoryCuratedRow(many)?.split('\n').at(-1)).toBe('and 2 more')
	})
})

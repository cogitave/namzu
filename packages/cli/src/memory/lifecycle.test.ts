import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	MarkdownMemoryStore,
	MockLLMProvider,
	SESSION_MEMORY_TAG,
	type SessionEvent,
	createMemoryRecallStep,
	createUserMessage,
	drainQuery,
	turnContextKey,
} from '@namzu/sdk'
import type { SessionId, TenantId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { MemoryLifecycle, SWEEP_IDLE_MS, SWEEP_MIN_GAP_MS } from './lifecycle.js'
import { loadManagedMemories, restoreManagedMemory } from './manage.js'
import { MemoryUsage } from './usage.js'

const DAY = 86_400_000
const roots: string[] = []
// Records take their creation time from the clock, so the test owns it.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(1_000)
})
afterEach(() => {
	vi.useRealTimers()
	for (const root of roots.splice(0)) removeTempDir(root)
})

/** A timer wheel the test turns by hand. */
function timers() {
	let nextId = 1
	const pending = new Map<number, { run: () => void | Promise<void>; ms: number }>()
	return {
		setTimer: (run: () => void | Promise<void>, ms: number) => {
			const id = nextId++
			pending.set(id, { run, ms })
			return id
		},
		clearTimer: (handle: unknown) => void pending.delete(handle as number),
		pending: () => [...pending.values()].map((timer) => timer.ms),
		/** Fire every timer that is armed, and wait for what each one started. */
		fire: async () => {
			const due = [...pending.values()]
			pending.clear()
			await Promise.all(due.map((timer) => timer.run()))
		},
	}
}

async function setup(options: { retireAfterDays?: number; busy?: () => boolean } = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'namzu-memory-lifecycle-'))
	roots.push(directory)
	const store = new MarkdownMemoryStore({ directory: join(directory, 'records') })
	let now = 1_000
	const usage = new MemoryUsage({ file: join(directory, 'usage.json'), now: () => now })
	const wheel = timers()
	const swept: number[] = []
	const lifecycle = new MemoryLifecycle({
		store,
		usage,
		now: () => now,
		retireAfterDays: options.retireAfterDays ?? 21,
		setTimer: wheel.setTimer,
		clearTimer: wheel.clearTimer,
		...(options.busy ? { isBusy: options.busy } : {}),
		onSwept: (report) => swept.push(report.archived.length),
	})
	return {
		directory,
		store,
		usage,
		lifecycle,
		wheel,
		swept,
		at: (value: number) => {
			now = value
		},
	}
}

describe('the lifecycle host', () => {
	it('counts what recall offered, and which of it a selector chose', async () => {
		const t = await setup()
		await t.lifecycle.start()
		t.lifecycle.observe({
			type: 'memory_recalled',
			memories: [
				{ id: 'a', title: 'A', origin: 'derived', updatedAt: 1, reason: 'asks about caching' },
				{ id: 'b', title: 'B', origin: 'derived', updatedAt: 1, reason: 'matched words' },
			],
		} as SessionEvent)
		expect(t.usage.get('a')).toMatchObject({ recalls: 1, selected: 1 })
		expect(t.usage.get('b')).toMatchObject({ recalls: 1, selected: 0 })
		expect(t.usage.dirty).toBe(true)
		// A turn releasing writes the counts.
		t.lifecycle.observe({ type: 'turn_completed' } as SessionEvent)
		await t.usage.flush()
		expect(t.usage.dirty).toBe(false)
	})

	it('waits for quiet before sweeping: not during a turn, not while the person types', async () => {
		let busy = true
		const t = await setup({ busy: () => busy })
		await t.lifecycle.start()
		const entry = (
			await t.store.create({
				title: 'Never recalled',
				summary: 's',
				content: 'body',
				metadata: { source: SESSION_MEMORY_TAG },
			})
		).entry
		expect(t.wheel.pending()).toEqual([SWEEP_IDLE_MS])
		// Counting starts at the first write.
		await t.usage.flush()
		t.usage.recalled(['x'])
		await t.usage.flush()

		t.at(1_000 + 40 * DAY)
		t.lifecycle.turnStarted()
		expect(t.wheel.pending()).toEqual([])
		t.lifecycle.turnSettled()
		expect(t.wheel.pending()).toEqual([SWEEP_IDLE_MS])

		await t.wheel.fire()
		expect(t.swept).toEqual([])
		expect((await t.store.getRecord(entry.id))?.entry.status).toBe('active')

		busy = false
		t.lifecycle.turnSettled()
		await t.wheel.fire()
		expect(t.swept).toEqual([1])
		expect((await t.store.getRecord(entry.id))?.entry.status).toBe('archived')
	})

	it('sweeps at most once in a while, and never after it is disposed', async () => {
		const t = await setup()
		await t.lifecycle.start()
		t.usage.recalled(['x'])
		await t.usage.flush()
		await t.store.create({
			title: 'First',
			summary: 's',
			content: 'one',
			metadata: { source: SESSION_MEMORY_TAG },
		})
		t.at(1_000 + 40 * DAY)
		t.lifecycle.turnSettled()
		await t.wheel.fire()
		expect(t.swept).toEqual([1])

		await t.store.create({
			title: 'Second',
			summary: 's',
			content: 'two',
			metadata: { source: SESSION_MEMORY_TAG },
		})
		t.at(1_000 + 80 * DAY)
		// Too soon after the last one: that is checked against the clock.
		t.at(1_000 + 40 * DAY + SWEEP_MIN_GAP_MS - 1)
		t.lifecycle.turnSettled()
		await t.wheel.fire()
		expect(t.swept).toEqual([1])

		await t.lifecycle.dispose()
		t.lifecycle.turnSettled()
		expect(t.wheel.pending()).toEqual([])
	})

	it('/memory tidy sweeps now, whatever the quiet, and prints what it did', async () => {
		const t = await setup()
		await t.lifecycle.start()
		t.usage.recalled(['x'])
		await t.usage.flush()
		await t.store.create({
			title: 'Old claim',
			summary: 's',
			content: 'c',
			metadata: { source: SESSION_MEMORY_TAG },
		})
		t.lifecycle.turnStarted()
		t.at(1_000 + 30 * DAY)
		const report = await t.lifecycle.tidy()
		expect(report.archived).toMatchObject([{ title: 'Old claim', reason: 'unused' }])
	})
})

describe('a refused request that carried memory', () => {
	const refused = {
		finishReason: 'content_filter' as const,
		refusal: { category: 'cyber', explanation: 'flagged' },
	}

	async function seeded() {
		const t = await setup()
		await t.lifecycle.start()
		const entry = (
			await t.store.create({
				title: 'Cache finding',
				summary: 'One discovery',
				content: 'cerulean-cache expires after 14 hours',
				metadata: { source: SESSION_MEMORY_TAG },
			})
		).entry
		return { ...t, entry }
	}

	async function turn(
		t: Awaited<ReturnType<typeof seeded>>,
		provider: MockLLMProvider,
		text = 'What did we learn about cerulean-cache expiry?',
	) {
		const events: SessionEvent[] = []
		const result = await drainQuery(
			{
				provider,
				toolsets: [],
				turnConfig: {
					model: 'primary-model',
					timeoutMs: 20_000,
					tokenBudget: 500_000,
					maxIterations: 6,
					maxResponseTokens: 2_000,
				},
				agentId: 'agent_m',
				agentName: 'Memory',
				messages: [createUserMessage(text)],
				workingDirectory: t.directory,
				sessionId: randomUUID() as SessionId,
				topicId: 'deff1264-c6c8-426e-b259-3409cefb8929',
				projectId: '013d6892-222f-41f6-84ea-144d389a3633',
				tenantId: '09baa4c3-d377-42ba-80c6-b90340766578' as TenantId,
				retry: false,
				prepareStep: createMemoryRecallStep({
					store: t.store,
					record: true,
					excluded: t.lifecycle.excluded,
				}),
				withholdOnRefusal: t.lifecycle.withholdOnRefusal,
				withheldKeys: t.lifecycle.withheldKeys(),
			} as never,
			(event) => {
				events.push(event)
				t.lifecycle.observe(event)
			},
		)
		return { result, events }
	}

	const carries = (request: { messages: readonly { role: string; source?: unknown }[] }) =>
		request.messages.some((message) => turnContextKey(message) === 'memory')
	const outcomes = (events: SessionEvent[]) =>
		events.flatMap((event) => (event.type === 'model_refusal' ? [event.outcome] : []))

	it('sets the memories aside and retries once without them', async () => {
		const t = await seeded()
		const provider = new MockLLMProvider({ turns: [refused, { text: 'Fine' }] })
		const { result, events } = await turn(t, provider)

		expect(provider.requests).toHaveLength(2)
		expect(carries(provider.requests[0] as never)).toBe(true)
		expect(carries(provider.requests[1] as never)).toBe(false)
		expect(result.stopReason).toBe('end_turn')
		expect(outcomes(events)).toEqual(['withheld'])
		expect(t.usage.isSetAside(t.entry.id)).toBe(true)
		// The conversation keeps asking without them: the host remembers.
		expect(t.lifecycle.withheldKeys()).toEqual(['memory'])
		await t.usage.flush()
	})

	it('falls through to the model fallback when the retry is refused too', async () => {
		const t = await seeded()
		const provider = new MockLLMProvider({
			refusalFallbackModel: 'fallback-model',
			turns: [refused, refused, { text: 'Elsewhere' }],
		})
		const { result, events } = await turn(t, provider)
		expect(provider.requests.map((request) => request.model)).toEqual([
			'primary-model',
			'primary-model',
			'fallback-model',
		])
		expect(outcomes(events)).toEqual(['withheld', 'fallback'])
		expect(result.stopReason).toBe('end_turn')
		expect(t.usage.isSetAside(t.entry.id)).toBe(true)
	})

	it('never recalls a set-aside memory again until it is restored in /memory', async () => {
		const t = await seeded()
		await turn(t, new MockLLMProvider({ turns: [refused, { text: 'Fine' }] }))
		await t.usage.flush()

		// A later conversation, even in another process: the sidecar remembers.
		const lateUsage = new MemoryUsage({ file: join(t.directory, 'usage.json'), now: () => 5_000 })
		const later = new MemoryLifecycle({
			store: t.store,
			usage: lateUsage,
			now: () => 5_000,
			retireAfterDays: 21,
			setTimer: t.wheel.setTimer,
			clearTimer: t.wheel.clearTimer,
		})
		await later.start()
		const quiet = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		await turn({ ...t, lifecycle: later }, quiet)
		expect(carries(quiet.requests[0] as never)).toBe(false)

		// Restored there, it is offered again.
		const listed = await loadManagedMemories(t.store, t.directory, { usage: lateUsage })
		await restoreManagedMemory(t.store, listed[0] as never, (id) => later.restore(id))
		const again = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		await turn(
			{
				...t,
				lifecycle: new MemoryLifecycle({
					store: t.store,
					usage: lateUsage,
					now: () => 5_000,
					retireAfterDays: 21,
					setTimer: t.wheel.setTimer,
					clearTimer: t.wheel.clearTimer,
				}),
			},
			again,
		)
		expect(carries(again.requests[0] as never)).toBe(true)
	})

	it('lists a set-aside memory in /memory and recalls it again once restored', async () => {
		const t = await seeded()
		await turn(t, new MockLLMProvider({ turns: [refused, { text: 'Fine' }] }))

		const listed = await loadManagedMemories(t.store, t.directory, { usage: t.usage })
		expect(listed).toMatchObject([{ id: t.entry.id, state: 'set-aside' }])
		expect(
			await restoreManagedMemory(t.store, listed[0] as never, (id) => t.lifecycle.restore(id)),
		).toBe('restored')
		expect(t.usage.isSetAside(t.entry.id)).toBe(false)

		// A fresh conversation: nothing is withheld by the host any more.
		const fresh = new MemoryLifecycle({
			store: t.store,
			usage: t.usage,
			now: () => 5_000,
			retireAfterDays: 21,
			setTimer: t.wheel.setTimer,
			clearTimer: t.wheel.clearTimer,
		})
		const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		await turn({ ...t, lifecycle: fresh }, provider)
		expect(carries(provider.requests[0] as never)).toBe(true)
	})

	it('does nothing about memory when the request carried none', async () => {
		const t = await seeded()
		const provider = new MockLLMProvider({
			refusalFallbackModel: 'fallback-model',
			turns: [refused, { text: 'ok' }],
		})
		const { events } = await turn(t, provider, 'Something unrelated entirely')
		expect(outcomes(events)).toEqual(['fallback'])
		expect(t.usage.isSetAside(t.entry.id)).toBe(false)
	})
})

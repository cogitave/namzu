import { describe, expect, it, vi } from 'vitest'
import { InMemoryMemoryStore } from '../../store/memory/memory.js'
import {
	type Message,
	createAssistantMessage,
	createTurnContextEntry,
	createUserMessage,
} from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/session/prepare-step.js'
import { generateSessionId, generateTurnId } from '../../utils/id.js'
import {
	type MemorySelection,
	type MemorySelectorInput,
	createMemoryRecallStep,
} from '../memory-recall.js'

/**
 * A selector chooses among the lexical candidates once per user message; when
 * it does not answer, lexical order applies, held to `minCoverage`.
 */

const SESSION_ID = generateSessionId()
const QUERY = 'How long does the cerulean cache last before it expires?'

function context(messages: Message[], turnId = generateTurnId()): PrepareStepContext {
	return { sessionId: SESSION_ID, turnId, stepNumber: 1, messages, steps: [], prepared: {} }
}

async function seeded() {
	const store = new InMemoryMemoryStore()
	const make = async (title: string, summary: string, content: string) =>
		(await store.create({ title, summary, content })).entry
	const both = await make(
		'Cerulean cache expiry',
		'How long the cache lasts',
		'It expires in 14 hours',
	)
	const other = await make(
		'Cache warmup',
		'Warm the cerulean pool',
		'Run the warmup script on deploy',
	)
	const oneWord = await make(
		'Billing notes',
		'Invoices and the cache of receipts',
		'Unrelated to expiry rules',
	)
	return { store, both, other, oneWord }
}

const ids = (text: string | undefined, all: readonly { id: string }[]) =>
	all.filter((entry) => text?.includes(entry.id)).map((entry) => entry.id)

describe('memory recall selector', () => {
	it('adds only the records the selector chose, with its reason, and hands it no bodies', async () => {
		const { store, both, other, oneWord } = await seeded()
		let seen: MemorySelectorInput | undefined
		const recall = createMemoryRecallStep({
			store,
			record: true,
			shortlist: 8,
			select: async (input) => {
				seen = input
				return [{ id: other.id, why: 'warmup helps' }]
			},
		})
		const result = await recall(
			context([
				createUserMessage('Earlier'),
				createAssistantMessage('Line one.\nI can look at the cache next.'),
				createUserMessage(QUERY),
			]),
		)
		expect(ids(result?.recordedContext?.[0]?.text, [both, other])).toEqual([other.id])
		expect(result?.recordedContext?.[0]?.recalledMemories).toEqual([
			expect.objectContaining({ id: other.id, reason: 'warmup helps' }),
		])
		expect(seen?.query).toBe(QUERY)
		expect(seen?.recent).toBe('I can look at the cache next.')
		expect(seen?.candidates.map((c) => c.id).sort()).toEqual([both.id, other.id, oneWord.id].sort())
		expect(JSON.stringify(seen?.candidates)).not.toContain('14 hours')
		expect(seen?.candidates[0]).toEqual(
			expect.objectContaining({ origin: 'operator', age: 'today' }),
		)
	})

	it('ignores ids outside the shortlist, repeats, and keeps the selector order and cap', async () => {
		const { store, both, other } = await seeded()
		const recall = createMemoryRecallStep({
			store,
			maxMemories: 2,
			shortlist: 8,
			select: async () => [
				{ id: 'not-a-record' },
				{ id: other.id },
				{ id: other.id },
				{ id: both.id },
			],
		})
		const text = (await recall(context([createUserMessage(QUERY)])))?.context ?? ''
		expect(text.indexOf(other.id)).toBeGreaterThan(-1)
		expect(text.indexOf(other.id)).toBeLessThan(text.indexOf(both.id))
		expect(text).not.toContain('not-a-record')
	})

	it('adds nothing when the selector says nothing is relevant', async () => {
		const { store } = await seeded()
		const recall = createMemoryRecallStep({ store, select: async () => [] })
		expect(await recall(context([createUserMessage(QUERY)]))).toBeUndefined()
	})

	it('does not call the selector when no record is a candidate', async () => {
		const { store } = await seeded()
		const select = vi.fn(async () => [] as MemorySelection[])
		const recall = createMemoryRecallStep({ store, select })
		await recall(context([createUserMessage('zebra quagga okapi')]))
		expect(select).not.toHaveBeenCalled()
	})

	it('decides once per user message across tool steps, and again for the next message', async () => {
		const { store, both } = await seeded()
		const select = vi.fn(async () => [{ id: both.id }])
		const recall = createMemoryRecallStep({ store, shortlist: 8, select })
		const first = [createUserMessage(QUERY)]
		await recall(context(first))
		await recall(context([...first, createAssistantMessage('Looking.')]))
		expect(select).toHaveBeenCalledTimes(1)
		await recall(context([...first, createUserMessage('And what about cerulean warmup?')]))
		expect(select).toHaveBeenCalledTimes(2)
	})

	it('keeps a decision that chose nothing for the tool steps that follow', async () => {
		const { store } = await seeded()
		const select = vi.fn(async () => [] as MemorySelection[])
		const recall = createMemoryRecallStep({ store, select })
		const messages = [createUserMessage(QUERY)]
		await recall(context(messages))
		await recall(context(messages))
		expect(select).toHaveBeenCalledTimes(1)
	})

	it('does not offer again what the conversation already holds', async () => {
		const { store, both, other } = await seeded()
		const select = vi.fn(async (input: MemorySelectorInput) =>
			input.candidates.map((c) => ({ id: c.id })),
		)
		const recall = createMemoryRecallStep({ store, record: true, shortlist: 8, select })
		const history: Message[] = [createUserMessage(QUERY)]
		const first = await recall(context(history))
		for (const item of first?.recordedContext ?? [])
			history.push(createTurnContextEntry(item.key, item.text))
		expect(ids(first?.recordedContext?.[0]?.text, [both, other]).length).toBeGreaterThan(0)
		expect(await recall(context(history))).toBeUndefined()
	})

	describe('when the selector does not answer', () => {
		it.each([
			['undefined', async () => undefined],
			[
				'a throw',
				async () => {
					throw new Error('model unavailable')
				},
			],
		])('falls back to lexical order on %s, held to minCoverage', async (_name, select) => {
			const { store, both, other, oneWord } = await seeded()
			const withCoverage = createMemoryRecallStep({ store, minCoverage: 2, select })
			const picked = ids((await withCoverage(context([createUserMessage(QUERY)])))?.context, [
				both,
				other,
				oneWord,
			])
			expect(picked).toContain(both.id)
			expect(picked).not.toContain(oneWord.id)
			const lenient = createMemoryRecallStep({ store, select })
			const all = ids((await lenient(context([createUserMessage(QUERY)])))?.context, [
				both,
				other,
				oneWord,
			])
			expect(all).toContain(oneWord.id)
		})

		it('treats an abort as no answer, under fake timers', async () => {
			vi.useFakeTimers()
			try {
				const { store, both, oneWord } = await seeded()
				let aborted = false
				const recall = createMemoryRecallStep({
					store,
					minCoverage: 2,
					selectTimeoutMs: 500,
					select: ({ signal }) =>
						new Promise((_, reject) => {
							signal.addEventListener('abort', () => {
								aborted = true
								reject(new Error('aborted'))
							})
						}),
				})
				const pending = recall(context([createUserMessage(QUERY)]))
				await vi.advanceTimersByTimeAsync(500)
				const result = await pending
				expect(aborted).toBe(true)
				const picked = ids(result?.context, [both, oneWord])
				expect(picked).toContain(both.id)
				expect(picked).not.toContain(oneWord.id)
			} finally {
				vi.useRealTimers()
			}
		})

		it('does not spend the store-read budget while the selector runs', async () => {
			vi.useFakeTimers()
			try {
				const { store, both } = await seeded()
				const recall = createMemoryRecallStep({
					store,
					timeoutMs: 1_000,
					selectTimeoutMs: 5_000,
					select: () =>
						new Promise((resolve) => setTimeout(() => resolve([{ id: both.id }]), 3_000)),
				})
				const pending = recall(context([createUserMessage(QUERY)]))
				await vi.advanceTimersByTimeAsync(3_000)
				expect(ids((await pending)?.context, [both])).toEqual([both.id])
			} finally {
				vi.useRealTimers()
			}
		})
	})

	it('cancels the selector with the turn', async () => {
		const { store } = await seeded()
		const controller = new AbortController()
		let seen: AbortSignal | undefined
		let called!: () => void
		const calledPromise = new Promise<void>((resolve) => {
			called = resolve
		})
		const recall = createMemoryRecallStep({
			store,
			select: ({ signal }) => {
				seen = signal
				called()
				return new Promise(() => undefined)
			},
		})
		const pending = recall({ ...context([createUserMessage(QUERY)]), signal: controller.signal })
		await calledPromise
		controller.abort(new Error('cancelled'))
		await expect(pending).rejects.toThrow(/cancelled/)
		expect(seen?.aborted).toBe(true)
	})

	it('reproduces today when nothing new is configured', async () => {
		const { store, both, other, oneWord } = await seeded()
		const result = await createMemoryRecallStep({ store, record: true })(
			context([createUserMessage(QUERY)]),
		)
		expect(ids(result?.recordedContext?.[0]?.text, [both, other, oneWord]).sort()).toEqual(
			[both.id, other.id, oneWord.id].sort(),
		)
		for (const shown of result?.recordedContext?.[0]?.recalledMemories ?? [])
			expect(shown).not.toHaveProperty('reason')
	})

	it('keeps the earlier header and adds no other-matches line when nothing new is configured', async () => {
		const { store } = await seeded()
		const text = (
			await createMemoryRecallStep({ store, maxMemories: 1 })(context([createUserMessage(QUERY)]))
		)?.context
		expect(text).toContain('Retrieved project memory')
		expect(text).not.toContain('Use a record only if it actually applies')
		expect(text).not.toContain('other memor')
	})

	it('says how many other memories matched when the words chose, not when the selector answered', async () => {
		const { store, both } = await seeded()
		const base = { store, maxMemories: 1, shortlist: 8 }
		const words = (
			await createMemoryRecallStep({ ...base, select: async () => undefined })(
				context([createUserMessage(QUERY)]),
			)
		)?.context
		expect(words).toMatch(/2 other memories matched; search_memory can find them\./)
		expect(words).toContain('Use a record only if it actually applies')
		const chosen = (
			await createMemoryRecallStep({ ...base, select: async () => [{ id: both.id }] })(
				context([createUserMessage(QUERY)]),
			)
		)?.context
		expect(chosen).not.toContain('other memor')
	})

	it('reads down the whole shortlist for coverage, so one-word matches do not use up the places', async () => {
		const store = new InMemoryMemoryStore()
		const decoys = []
		for (const n of ['one', 'two', 'three'])
			decoys.push(
				(
					await store.create({
						title: `Cerulean ${n}`,
						summary: `Paint ${n}`,
						content: `Shade ${n}`,
					})
				).entry,
			)
		const target = (
			await store.create({
				title: 'Warmup notes',
				summary: 'Deploy chores',
				content: 'The cerulean cache is refilled by hand',
			})
		).entry
		const text = (
			await createMemoryRecallStep({
				store,
				shortlist: 8,
				minCoverage: 2,
				select: async () => undefined,
			})(context([createUserMessage(QUERY)]))
		)?.context
		expect(ids(text, [target, ...decoys])).toEqual([target.id])
	})

	describe('the decision kept for a message', () => {
		it('asks again for the same words sent as a new message', async () => {
			const { store, both } = await seeded()
			const select = vi.fn(async () => [{ id: both.id }])
			const recall = createMemoryRecallStep({ store, shortlist: 8, select })
			const first = [createUserMessage(QUERY), createAssistantMessage('Done.')]
			await recall(context(first))
			await recall(context([...first, createUserMessage(QUERY)]))
			expect(select).toHaveBeenCalledTimes(2)
		})

		it('reuses it for a steering note inside the turn', async () => {
			const { store, both } = await seeded()
			const select = vi.fn(async () => [{ id: both.id }])
			const recall = createMemoryRecallStep({ store, shortlist: 8, select })
			const first = [createUserMessage(QUERY)]
			await recall(context(first))
			await recall(
				context([
					...first,
					createUserMessage('Also mind the cerulean warmup.', undefined, {
						type: 'runtime-context',
						kind: 'steering',
					}),
				]),
			)
			expect(select).toHaveBeenCalledTimes(1)
		})

		it('does not keep a decision lost to a cancelled turn', async () => {
			const { store } = await seeded()
			const controller = new AbortController()
			let called!: () => void
			const calledPromise = new Promise<void>((resolve) => {
				called = resolve
			})
			const select = vi.fn(({ signal }: MemorySelectorInput) => {
				called()
				return new Promise<readonly MemorySelection[] | undefined>((resolve) =>
					signal.addEventListener('abort', () => resolve(undefined), { once: true }),
				)
			})
			const recall = createMemoryRecallStep({ store, select })
			const messages = [createUserMessage(QUERY)]
			const pending = recall({ ...context(messages), signal: controller.signal })
			const settled = expect(pending).rejects.toThrow(/cancelled/)
			await calledPromise
			controller.abort(new Error('cancelled'))
			await settled
			// Let the dropped decision settle before the next step asks.
			await Promise.resolve()
			await Promise.resolve()
			select.mockImplementation(async () => [])
			await recall(context(messages))
			expect(select).toHaveBeenCalledTimes(2)
		})
	})
})

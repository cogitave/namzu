import { describe, expect, it, vi } from 'vitest'
import { InMemoryMemoryStore } from '../../store/memory/memory.js'
import type { MemoryStore } from '../../types/memory/index.js'
import { createRuntimeContextMessage, createUserMessage } from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/run/prepare-step.js'
import { generateRunId } from '../../utils/id.js'
import { createMemoryRecallStep } from '../memory-recall.js'

function context(query = 'What did we learn about cerulean-cache expiry?'): PrepareStepContext {
	return {
		runId: generateRunId(),
		stepNumber: 1,
		messages: [createUserMessage(query)],
		steps: [],
		prepared: {},
	}
}

async function fixture() {
	const store = new InMemoryMemoryStore()
	const { entry } = await store.create({
		title: 'Inspect service configuration',
		summary: 'One discovery',
		content: 'cerulean-cache expires after 14 hours',
		metadata: { runId: generateRunId() },
	})
	return { store, entry, recall: createMemoryRecallStep({ store }) }
}

describe('bounded memory recall', () => {
	it('finds body-only facts without a model search call and preserves upstream guidance', async () => {
		const { recall, entry } = await fixture()
		const result = await recall({
			...context(),
			prepared: { system: 'Keep the answer brief.' },
		})
		expect(result?.system).toContain('Keep the answer brief.')
		expect(result?.system).toContain('historical claims')
		expect(result?.system).toContain('14 hours')
		expect(result?.system).toContain(entry.id)
	})

	it('uses the latest operator topic and ignores runtime or project instruction text', async () => {
		const { recall } = await fixture()
		const current = context('Explain amber-queue, not the previous topic.')
		const messages = [
			createUserMessage('cerulean-cache'),
			...current.messages,
			createRuntimeContextMessage('cerulean-cache', 'task-completion'),
		]
		expect(await recall({ ...current, messages })).toBeUndefined()
		expect(
			await recall({
				...current,
				messages: [...messages, createRuntimeContextMessage('cerulean-cache', 'steering')],
			}),
		).toMatchObject({ system: expect.stringContaining('14 hours') })
	})

	it.each(['continue', 'devam kardeşim', ''])(
		'does not list arbitrary memories for %j',
		async (query) => {
			const { store, recall } = await fixture()
			const list = vi.spyOn(store, 'list')
			expect(await recall(context(query))).toBeUndefined()
			expect(list).not.toHaveBeenCalled()
		},
	)

	it('refreshes edited records and drops archived or deleted records on the next step', async () => {
		const { store, entry, recall } = await fixture()
		expect((await recall(context()))?.system).toContain('14 hours')
		await store.update(entry.id, {
			content: 'cerulean-cache expires after 28 hours',
		})
		const corrected = await recall(context())
		expect(corrected?.system).toContain('28 hours')
		expect(corrected?.system).not.toContain('14 hours')
		await store.update(entry.id, { status: 'archived' })
		expect(await recall(context())).toBeUndefined()
		await store.update(entry.id, { status: 'active' })
		await store.delete(entry.id)
		expect(await recall(context())).toBeUndefined()
	})

	it('does not recall records from another store', async () => {
		await fixture()
		expect(
			await createMemoryRecallStep({ store: new InMemoryMemoryStore() })(context()),
		).toBeUndefined()
	})

	it('caps the entire escaped block and avoids splitting surrogate pairs', async () => {
		const { store } = await fixture()
		for (let i = 0; i < 4; i++) {
			await store.create({
				title: `cerulean ${i}`,
				summary: '<"😀'.repeat(80),
				content: `cerulean-cache ${'<"😀'.repeat(1000)}`,
			})
		}
		const recalled = await createMemoryRecallStep({
			store,
			maxChars: 1200,
			maxMemories: 2,
		})(context())
		expect(recalled?.system?.length).toBeLessThanOrEqual(1200)
		const records = recalled?.system?.split('\n').filter((line) => line.startsWith('{')) ?? []
		expect(records.length).toBeLessThanOrEqual(2)
		for (const line of records) expect(() => JSON.parse(line)).not.toThrow()
		expect(recalled?.system).not.toContain('<')
	})

	it('bounds a stalled store and schedules no reads after the deadline', async () => {
		let release!: (value: Awaited<ReturnType<MemoryStore['list']>>) => void
		const { store, entry } = await fixture()
		vi.spyOn(store, 'list').mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const get = vi.spyOn(store, 'get')
		await expect(createMemoryRecallStep({ store, timeoutMs: 10 })(context())).rejects.toThrow(
			'Memory recall exceeded',
		)
		release({ entries: [entry], totalCount: 1 })
		await Promise.resolve()
		expect(get).not.toHaveBeenCalled()
	})

	it('keeps a complete Unicode character at the start of a matching excerpt', async () => {
		const store = new InMemoryMemoryStore()
		await store.create({
			title: 'Recorded fact',
			summary: 'Earlier investigation',
			content: `${'x'.repeat(50)}😀${'y'.repeat(118)} cerulean ${'z'.repeat(1500)}`,
		})
		const result = await createMemoryRecallStep({ store, maxChars: 1200 })(context('cerulean'))
		const line = result?.system?.split('\n').find((line) => line.startsWith('{'))
		expect(line).toBeDefined()
		const { excerpt } = JSON.parse(line ?? '{}') as { excerpt: string }
		expect(excerpt).toContain('cerulean')
		expect(excerpt.startsWith('…😀')).toBe(true)
	})

	it('uses the host baseline when there is no kernel-maintained current user message', async () => {
		const { store } = await fixture()
		const recall = createMemoryRecallStep({ store, query: 'cerulean-cache' })
		expect((await recall({ ...context(), messages: [] }))?.system).toContain('14 hours')
		expect(
			await recall({
				...context('continue'),
				latestUserMessage: createUserMessage('continue'),
			}),
		).toBeUndefined()
	})

	it('releases a stalled recall promptly on cancellation', async () => {
		const { store } = await fixture()
		vi.spyOn(store, 'list').mockImplementation(() => new Promise(() => {}))
		const controller = new AbortController()
		const pending = createMemoryRecallStep({ store, timeoutMs: 10000 })({
			...context(),
			signal: controller.signal,
		})
		controller.abort('operator stopped')
		await expect(pending).rejects.toThrow('cancelled')
	})

	it('uses current atomic metadata/body and refuses a record archived after selection', async () => {
		const { store, entry, recall } = await fixture()
		const original = store.getRecord.bind(store)
		vi.spyOn(store, 'getRecord').mockImplementation(async (id) => {
			await store.update(entry.id, {
				status: 'archived',
				content: 'a later obsolete claim',
			})
			return original(id)
		})
		expect(await recall(context())).toBeUndefined()
	})

	it('skips optional recall without touching the store when context headroom is too small', async () => {
		const { store, recall } = await fixture()
		const list = vi.spyOn(store, 'list')
		expect(
			await recall({
				...context(),
				contextBudget: { windowTokens: 1000, remainingTokens: 80 },
			}),
		).toBeUndefined()
		expect(list).not.toHaveBeenCalled()
	})

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'refuses invalid bounds %s',
		(bound) => {
			const store = new InMemoryMemoryStore()
			expect(() => createMemoryRecallStep({ store, maxChars: bound })).toThrow('positive integer')
			expect(() => createMemoryRecallStep({ store, maxMemories: bound })).toThrow(
				'positive integer',
			)
			expect(() => createMemoryRecallStep({ store, timeoutMs: bound })).toThrow('positive integer')
		},
	)
})

it('does not stack timed-out recalls across hooks sharing a store and reads fresh after release', async () => {
	const { store, entry } = await fixture()
	let release!: (value: Awaited<ReturnType<MemoryStore['list']>>) => void
	const original = store.list.bind(store)
	const list = vi.spyOn(store, 'list').mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve
			}),
	)
	const get = vi.spyOn(store, 'getRecord')
	const recall = createMemoryRecallStep({ store, timeoutMs: 5 })
	await expect(recall(context())).rejects.toThrow('Memory recall exceeded')
	for (let i = 0; i < 10; i++) {
		expect(await createMemoryRecallStep({ store, timeoutMs: 5 })(context())).toBeUndefined()
	}
	expect(list).toHaveBeenCalledTimes(1)
	const unrelated = await fixture()
	expect((await unrelated.recall(context()))?.system).toContain('14 hours')
	release({ entries: [entry], totalCount: 1 })
	await new Promise((resolve) => setTimeout(resolve, 0))
	expect(get).not.toHaveBeenCalled()
	await store.update(entry.id, { content: 'cerulean-cache expires after 28 hours' })
	list.mockImplementation(original)
	const fresh = await recall(context())
	expect(fresh?.system).toContain('28 hours')
	expect(fresh?.system).not.toContain('14 hours')
})

it('holds the admission slot through a stalled record read, including cancellation', async () => {
	const { store, entry } = await fixture()
	let release!: (value: Awaited<ReturnType<NonNullable<MemoryStore['getRecord']>>>) => void
	const record = await store.getRecord(entry.id)
	const get = vi.spyOn(store, 'getRecord').mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve
			}),
	)
	const list = vi.spyOn(store, 'list')
	const controller = new AbortController()
	const pending = createMemoryRecallStep({ store, timeoutMs: 10000 })({
		...context(),
		signal: controller.signal,
	})
	await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
	controller.abort('stop')
	await expect(pending).rejects.toThrow('cancelled')
	expect(await createMemoryRecallStep({ store })(context())).toBeUndefined()
	expect(list).toHaveBeenCalledTimes(1)
	release(record)
	await new Promise((resolve) => setTimeout(resolve, 0))
	expect((await createMemoryRecallStep({ store })(context()))?.system).toContain('14 hours')
})

it('releases admission after a rejected store operation', async () => {
	const { store } = await fixture()
	vi.spyOn(store, 'list').mockRejectedValueOnce(new Error('disk failed'))
	const recall = createMemoryRecallStep({ store })
	await expect(recall(context())).rejects.toThrow('disk failed')
	expect((await recall(context()))?.system).toContain('14 hours')
})

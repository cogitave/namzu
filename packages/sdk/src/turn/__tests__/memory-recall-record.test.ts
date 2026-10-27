import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryMemoryStore } from '../../store/memory/memory.js'
import {
	type Message,
	createTurnContextEntry,
	createUserMessage,
} from '../../types/message/index.js'
import type { PrepareStepContext, PrepareStepResult } from '../../types/session/prepare-step.js'
import { generateSessionId, generateTurnId } from '../../utils/id.js'
import { RECALLED_MEMORY_ENTRY_KEY, createMemoryRecallStep } from '../memory-recall.js'

/**
 * With `record`, recalled project memory is kept in the conversation: a record
 * is recorded once, offered again only when it was updated, and the total the
 * conversation holds is bounded.
 */

const SESSION_ID = generateSessionId()
const QUERY = 'What did we learn about cerulean-cache expiry?'

function context(messages: Message[], prepared: PrepareStepResult = {}): PrepareStepContext {
	return {
		sessionId: SESSION_ID,
		turnId: generateTurnId(),
		stepNumber: 1,
		messages,
		steps: [],
		prepared,
	}
}

let clockTime = 1_000
vi.spyOn(Date, 'now').mockImplementation(() => ++clockTime)
afterEach(() => {
	clockTime = 1_000
})

async function seeded(count = 1) {
	const store = new InMemoryMemoryStore()
	const entries = []
	for (let i = 0; i < count; i++) {
		const { entry } = await store.create({
			title: `Cache finding ${i}`,
			summary: 'One discovery',
			content: `cerulean-cache expires after ${14 + i} hours`,
		})
		entries.push(entry)
	}
	return { store, entries }
}

/** What the loop does with a step's result: append each item as an entry. */
function keep(history: Message[], result: PrepareStepResult | undefined): void {
	for (const item of result?.recordedContext ?? [])
		history.push(createTurnContextEntry(item.key, item.text))
}

describe('recalled memory recorded in the conversation', () => {
	it('records the records it selects under one key, and leaves request-only context alone', async () => {
		const { store } = await seeded()
		const history: Message[] = [createUserMessage(QUERY)]
		const result = await createMemoryRecallStep({ store, record: true })(
			context(history, { context: 'Earlier request context.' }),
		)

		expect(result?.context).toBeUndefined()
		expect(result?.recordedContext).toHaveLength(1)
		expect(result?.recordedContext?.[0]?.key).toBe(RECALLED_MEMORY_ENTRY_KEY)
		expect(result?.recordedContext?.[0]?.text).toContain('cerulean-cache expires after 14 hours')
	})

	it('keeps the old request-only behaviour when record is not set', async () => {
		const { store } = await seeded()
		const result = await createMemoryRecallStep({ store })(context([createUserMessage(QUERY)]))
		expect(result?.recordedContext).toBeUndefined()
		expect(result?.context).toContain('cerulean-cache expires after 14 hours')
	})

	it('adds nothing for records an earlier entry already carries', async () => {
		const { store } = await seeded()
		const recall = createMemoryRecallStep({ store, record: true })
		const history: Message[] = [createUserMessage(QUERY)]
		keep(history, await recall(context(history)))
		history.push(createUserMessage('And what about cerulean-cache expiry now?'))

		expect(await recall(context(history))).toBeUndefined()
	})

	it('offers a record again when it was updated, and only that record', async () => {
		const { store, entries } = await seeded(2)
		const recall = createMemoryRecallStep({ store, record: true })
		const history: Message[] = [createUserMessage(QUERY)]
		keep(history, await recall(context(history)))

		await store.update(entries[1]?.id as never, {
			content: 'cerulean-cache now expires after 99 hours',
		})
		const result = await recall(context(history))

		const text = result?.recordedContext?.[0]?.text ?? ''
		expect(text).toContain('99 hours')
		expect(text, 'the record that did not change is not repeated').not.toContain('14 hours')
	})

	it('offers a new record that matches, behind records already held', async () => {
		const { store } = await seeded(3)
		const recall = createMemoryRecallStep({ store, record: true, maxMemories: 3 })
		const history: Message[] = [createUserMessage(QUERY)]
		keep(history, await recall(context(history)))
		await store.create({
			title: 'A later finding',
			summary: '',
			content: 'cerulean-cache is purged on deploy',
		})

		const text = (await recall(context(history)))?.recordedContext?.[0]?.text ?? ''
		expect(text).toContain('purged on deploy')
		expect(text).not.toContain('Cache finding 0')
	})

	it('stops adding records once the conversation holds the session budget', async () => {
		const { store } = await seeded(2)
		const history: Message[] = [createUserMessage(QUERY)]
		const first = await createMemoryRecallStep({ store, record: true })(context(history))
		keep(history, first)
		await store.create({
			title: 'Another',
			summary: '',
			content: 'cerulean-cache is purged on deploy',
		})

		const held = first?.recordedContext?.[0]?.text.length ?? 0
		expect(
			await createMemoryRecallStep({ store, record: true, sessionMaxChars: held })(
				context(history),
			),
		).toBeUndefined()
		expect(
			(
				await createMemoryRecallStep({ store, record: true, sessionMaxChars: held + 10_000 })(
					context(history),
				)
			)?.recordedContext?.[0]?.text,
		).toContain('purged on deploy')
	})

	it('offers everything again once the entries are gone from the history', async () => {
		const { store } = await seeded()
		const recall = createMemoryRecallStep({ store, record: true })
		const history: Message[] = [createUserMessage(QUERY)]
		keep(history, await recall(context(history)))

		const afterCompaction: Message[] = [createUserMessage(QUERY)]
		const again = await recall(context(afterCompaction))
		expect(again?.recordedContext?.[0]?.text).toContain('14 hours')
	})

	it('rejects a session budget that is not a positive whole number', () => {
		const store = new InMemoryMemoryStore()
		expect(() => createMemoryRecallStep({ store, record: true, sessionMaxChars: 0 })).toThrow(
			'sessionMaxChars',
		)
	})
})

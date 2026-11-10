import { describe, expect, it } from 'vitest'
import { InMemoryMemoryStore } from '../../store/memory/memory.js'
import { type Message, createUserMessage } from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/session/prepare-step.js'
import { generateSessionId, generateTurnId } from '../../utils/id.js'
import { createMemoryRecallStep } from '../memory-recall.js'

const SESSION_ID = generateSessionId()
const QUERY = 'Where does the cerulean cache live?'

const context = (messages: Message[]): PrepareStepContext => ({
	sessionId: SESSION_ID,
	turnId: generateTurnId(),
	stepNumber: 1,
	messages,
	steps: [],
	prepared: {},
})

async function seeded() {
	const store = new InMemoryMemoryStore()
	const one = (
		await store.create({
			title: 'Cerulean cache home',
			summary: 'Where the cerulean cache lives',
			content: 'It lives in src/cache.ts',
			metadata: { anchors: [{ path: 'src/cache.ts' }] },
		})
	).entry
	return { store, one }
}

describe('memory recall caution', () => {
	it('puts the host caution on the record line and on the event entry, and still shows the record', async () => {
		const { store, one } = await seeded()
		const seen: { id: string; metadata?: Readonly<Record<string, unknown>> }[] = []
		const recall = createMemoryRecallStep({
			store,
			record: true,
			caution: (record) => {
				seen.push(record)
				return 'may be out of date: src/cache.ts no longer exists since this was saved'
			},
		})
		const result = await recall(context([createUserMessage(QUERY)]))
		const text = result?.recordedContext?.[0]?.text ?? ''
		expect(text).toContain(one.id)
		expect(text).toContain('"caution":"may be out of date: src/cache.ts')
		expect(seen).toHaveLength(1)
		expect(seen[0]?.metadata).toEqual({ anchors: [{ path: 'src/cache.ts' }] })
		expect(result?.recordedContext?.[0]?.recalledMemories?.[0]?.caution).toMatch(
			/^may be out of date/,
		)
	})

	it('adds nothing when the host has nothing to say, or its check throws', async () => {
		for (const caution of [() => undefined, () => Promise.reject(new Error('boom'))]) {
			const { store, one } = await seeded()
			const recall = createMemoryRecallStep({ store, caution, record: true })
			const result = await recall(context([createUserMessage(QUERY)]))
			const text = result?.recordedContext?.[0]?.text ?? ''
			expect(text).toContain(one.id)
			expect(text).not.toContain('caution')
		}
	})
})

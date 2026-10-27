import { describe, expect, it } from 'vitest'

import { isInboundDeliveryRef } from './inbound-delivery.js'
import {
	RUNTIME_CONTEXT_MESSAGE_KINDS,
	createRuntimeContextMessage,
	createTurnContextEntry,
	isRuntimeContextMessageSource,
	isTurnContextEntry,
	isTurnContextKey,
	lastPromptText,
	turnContextEntries,
	turnContextKey,
} from './index.js'

describe('runtime-authored user-message provenance', () => {
	it.each(RUNTIME_CONTEXT_MESSAGE_KINDS)('builds and recognizes %s context', (kind) => {
		const message = createRuntimeContextMessage('exact provider context', kind)

		expect(message).toMatchObject({
			role: 'user',
			content: 'exact provider context',
			source: { type: 'runtime-context', kind },
		})
		expect(isRuntimeContextMessageSource(message.source)).toBe(true)
	})

	it.each([
		undefined,
		null,
		[],
		{},
		{ type: 'runtime-context' },
		{ type: 'runtime-context', kind: 'operator' },
		{ type: 'runtime-context', kind: 1 },
		{ type: 'goal-round', kind: 'advisory' },
	])('rejects malformed or unadmitted source %#', (source) => {
		expect(isRuntimeContextMessageSource(source)).toBe(false)
	})

	it('recognizes a bounded delivery reference without changing source authority', () => {
		const deliveryRef = {
			namespace: 'namzu-pal-message/1',
			id: 'a'.repeat(64),
			digest: 'b'.repeat(64),
		}
		expect(isInboundDeliveryRef(deliveryRef)).toBe(true)
		expect(
			isRuntimeContextMessageSource({ type: 'runtime-context', kind: 'peer-message', deliveryRef }),
		).toBe(true)
	})

	it.each([
		null,
		[],
		{},
		{ namespace: '', id: 'id', digest: 'digest' },
		{ namespace: 'test', id: 'x'.repeat(513), digest: 'digest' },
		{ namespace: 'test', id: 'id', digest: 'bad\nvalue' },
	])('rejects malformed delivery references %#', (deliveryRef) => {
		expect(isInboundDeliveryRef(deliveryRef)).toBe(false)
		expect(
			isRuntimeContextMessageSource({ type: 'runtime-context', kind: 'peer-message', deliveryRef }),
		).toBe(false)
	})
})

describe('recorded context entries', () => {
	const at = new Date(2026, 9, 27, 9, 5)

	it('freezes a header and the text into the content, filed under a key', () => {
		const entry = createTurnContextEntry('repository', 'on branch main', at)
		expect(entry).toMatchObject({
			role: 'user',
			source: { type: 'runtime-context', kind: 'turn-context', key: 'repository' },
		})
		expect(entry.content).toBe(
			'Recorded context (runtime-generated; not a new user request) - repository, as of 2026-10-27 09:05. A later entry with this key adds to or replaces what it says:\non branch main',
		)
		expect(isRuntimeContextMessageSource(entry.source)).toBe(true)
		expect(isTurnContextEntry(entry)).toBe(true)
		expect(turnContextKey(entry)).toBe('repository')
	})

	it('leaves the sentence about later entries out of an entry that follows another', () => {
		const entry = createTurnContextEntry('repository', 'on branch main', at, { later: true })
		expect(entry.content).toBe(
			'Recorded context (runtime-generated; not a new user request) - repository, as of 2026-10-27 09:05:\non branch main',
		)
		expect(turnContextKey(entry)).toBe('repository')
		expect(turnContextEntries([entry], 'repository')).toEqual(['on branch main'])
	})

	it('survives a JSON round trip unchanged', () => {
		const entry = createTurnContextEntry('file-evidence', 'a\nb', at)
		const again = JSON.parse(JSON.stringify(entry))
		expect(again).toEqual(entry)
		expect(isRuntimeContextMessageSource(again.source)).toBe(true)
		expect(turnContextKey(again)).toBe('file-evidence')
	})

	it('is not taken for any other kind of message', () => {
		const other = createRuntimeContextMessage('x', 'step-context')
		expect(isTurnContextEntry(other)).toBe(false)
		expect(turnContextKey(other)).toBeUndefined()
		expect(isTurnContextEntry({ role: 'assistant' })).toBe(false)
	})

	it.each(['', 'Repo', '1abc', 'a b', 'a_b', 'x'.repeat(65), 7, null])(
		'rejects the key %j',
		(key) => {
			expect(isTurnContextKey(key)).toBe(false)
			expect(
				isRuntimeContextMessageSource({ type: 'runtime-context', kind: 'turn-context', key }),
			).toBe(false)
		},
	)

	it('throws for a bad key at build time', () => {
		expect(() => createTurnContextEntry('Bad Key', 'x')).toThrow(TypeError)
	})

	it('is not taken for the question when a history ends in one', () => {
		const history = [
			{ role: 'user' as const, content: 'the question' },
			{ role: 'assistant' as const, content: 'an answer' },
			createTurnContextEntry('repository', 'on branch main', at),
		]
		expect(lastPromptText(history)).toBe('the question')
		expect(lastPromptText([history[2] as (typeof history)[number]])).toBe('')
	})
})

import { describe, expect, it } from 'vitest'

import { isInboundDeliveryRef } from './inbound-delivery.js'
import {
	RUNTIME_CONTEXT_MESSAGE_KINDS,
	createRuntimeContextMessage,
	isRuntimeContextMessageSource,
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

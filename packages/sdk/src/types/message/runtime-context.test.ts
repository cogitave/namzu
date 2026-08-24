import { describe, expect, it } from 'vitest'

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
})

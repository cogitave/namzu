import { describe, expect, it } from 'vitest'

import { withProviderFallback } from '../../../provider/fallback.js'
import type { ChatCompletionParams, LLMProvider } from '../../../types/provider/index.js'
import {
	DEFAULT_MAX_REQUEST_RICH_CONTENT_BYTES,
	resolveMaxRequestRichContentBytes,
} from '../request-rich-content.js'

const MIB = 1024 * 1024

describe('request rich-content budget resolution', () => {
	it('is the kernel default for a provider that declares nothing', () => {
		expect(resolveMaxRequestRichContentBytes(undefined, undefined)).toBe(
			DEFAULT_MAX_REQUEST_RICH_CONTENT_BYTES,
		)
		expect(DEFAULT_MAX_REQUEST_RICH_CONTENT_BYTES).toBe(24 * MIB)
	})

	it('takes the provider declaration over the default', () => {
		expect(resolveMaxRequestRichContentBytes(undefined, 100 * MIB)).toBe(100 * MIB)
	})

	it('lets the turn override beat the provider, in both directions', () => {
		expect(resolveMaxRequestRichContentBytes(8 * MIB, 100 * MIB)).toBe(8 * MIB)
		expect(resolveMaxRequestRichContentBytes(200 * MIB, 20 * MIB)).toBe(200 * MIB)
		expect(resolveMaxRequestRichContentBytes(0, 100 * MIB)).toBe(0)
	})

	it('still validates a provider declaration', () => {
		expect(() => resolveMaxRequestRichContentBytes(undefined, -1)).toThrow(RangeError)
	})
})

function member(id: string, budget?: number): LLMProvider {
	return {
		id,
		name: id,
		capabilities: {
			supportsTools: true,
			supportsStreaming: true,
			supportsFunctionCalling: true,
			...(budget !== undefined ? { maxRequestRichContentBytes: budget } : {}),
		},
		async *chatStream(_params: ChatCompletionParams) {},
	} as unknown as LLMProvider
}

describe('a fallback chain', () => {
	it('is limited by its smallest member, counting a silent one as the default', () => {
		const chain = withProviderFallback([
			{ provider: member('a', 100 * MIB), model: 'm' },
			{ provider: member('b'), model: 'm' },
		])
		expect(chain.capabilities?.maxRequestRichContentBytes).toBe(24 * MIB)
		const wide = withProviderFallback([
			{ provider: member('a', 100 * MIB), model: 'm' },
			{ provider: member('b', 50 * MIB), model: 'm' },
		])
		expect(wide.capabilities?.maxRequestRichContentBytes).toBe(50 * MIB)
	})

	it('declares nothing when no member does', () => {
		const chain = withProviderFallback([
			{ provider: member('a'), model: 'm' },
			{ provider: member('b'), model: 'm' },
		])
		expect(chain.capabilities?.maxRequestRichContentBytes).toBeUndefined()
	})
})

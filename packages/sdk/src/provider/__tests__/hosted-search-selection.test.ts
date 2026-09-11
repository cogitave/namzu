import { expect, it } from 'vitest'
import type { LLMProvider } from '../../types/provider/interface.js'
import { assertHostedWebSearchSupported } from '../capabilities.js'
import { withProviderFallback } from '../fallback.js'
import { withStreamIdleTimeout } from '../idle-timeout.js'
import { withProviderRetry } from '../retry.js'

const provider: LLMProvider = {
	id: 'fixture',
	name: 'Fixture',
	capabilities: {
		supportsTools: true,
		supportsStreaming: true,
		supportsFunctionCalling: true,
		supportsHostedWebSearch: true,
	},
	supportsHostedWebSearchFor(model, mode) {
		return this.id === 'fixture' && model === 'supported' && mode === 'live'
	},
	async *chatStream() {
		yield { id: 'x', delta: { content: 'ok' }, finishReason: 'stop' }
	},
}
it('retains model/mode search support through runtime decorators', () => {
	for (const wrapped of [
		withProviderRetry(provider),
		withStreamIdleTimeout(provider, { idleTimeoutMs: 1000 }),
	]) {
		expect(wrapped.supportsHostedWebSearchFor?.('supported', 'live')).toBe(true)
		expect(wrapped.supportsHostedWebSearchFor?.('supported', 'cached')).toBe(false)
		expect(() =>
			assertHostedWebSearchSupported(wrapped, { model: 'unknown', webSearch: { mode: 'live' } }),
		).toThrow()
	}
})
it('requires every fallback member to support search on its selected model', () => {
	const safe = withProviderFallback([
		{ provider, model: 'supported' },
		{ provider, model: 'supported' },
	])
	const unsafe = withProviderFallback([
		{ provider, model: 'supported' },
		{ provider, model: 'unknown' },
	])
	expect(safe.supportsHostedWebSearchFor?.('irrelevant', 'live')).toBe(true)
	expect(unsafe.supportsHostedWebSearchFor?.('supported', 'live')).toBe(false)
})

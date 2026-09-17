import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { OpenRouterProvider } from '../client.js'

/**
 * The shared guard's own tests pass whether or not this driver calls it, so
 * this drives the real chatStream. The defect being fixed was a declared
 * parameter no code path consumed — asserting the helper works would have
 * reproduced that shape one level up.
 *
 * The guard runs before any request, so the host below is never dialled on
 * the throwing cases, and the one case that must dial — the explicit disable,
 * which the guard lets past — is pointed at an address that CANNOT answer
 * rather than at the real service. That is the difference between a case that
 * asserts the guard let the request through and a case that asserts this
 * machine has a working, fast route to openrouter.ai: it went red on a CI
 * runner whose egress to the service took longer than the 5 s test timeout,
 * which said nothing about the guard. Nothing listens on 127.0.0.1:1 (binding
 * it needs root), so the dial is refused at once, on every machine.
 */

const provider = new OpenRouterProvider({
	apiKey: 'test-key',
	baseUrl: 'http://127.0.0.1:1',
} as never)

async function run(thinking?: ChatCompletionParams['thinking']): Promise<void> {
	for await (const _chunk of provider.chatStream({
		model: 'anthropic/claude-sonnet-4.5',
		messages: [{ role: 'user', content: 'hi' }],
		...(thinking ? { thinking } : {}),
	} as ChatCompletionParams)) {
		// drain
	}
}

describe('OpenRouterProvider refuses a thinking request rather than dropping it', () => {
	it('throws on a manual thinking request', async () => {
		await expect(run({ type: 'enabled', budgetTokens: 10_000 })).rejects.toThrow(
			/OpenRouterProvider does not implement thinking/,
		)
	})

	it('throws on an adaptive one', async () => {
		await expect(run({ type: 'adaptive' })).rejects.toThrow(/does not implement thinking/)
	})

	it('does not throw for an explicit disable', async () => {
		// Fails on the unreachable host instead, which is the point: the
		// guard let it past.
		await expect(run({ type: 'disabled' })).rejects.not.toThrow(/does not implement thinking/)
	})
})

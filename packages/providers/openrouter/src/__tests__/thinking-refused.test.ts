import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { OpenRouterProvider } from '../client.js'

/**
 * The shared guard's own tests pass whether or not this driver calls it, so
 * this drives the real chatStream. The defect being fixed was a declared
 * parameter no code path consumed — asserting the helper works would have
 * reproduced that shape one level up.
 *
 * The guard runs before any request, so the unreachable host below is never
 * dialled on the throwing cases.
 */

const provider = new OpenRouterProvider({ apiKey: 'test-key' } as never)

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

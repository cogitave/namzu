import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { HttpProvider } from '../client.js'

/**
 * The shared guard's own tests pass whether or not this driver calls it, so
 * this drives the real chatStream. The defect being fixed was a declared
 * parameter no code path consumed — asserting the helper works would have
 * reproduced that shape one level up.
 *
 * The guard runs before any request, so the unreachable host below is never
 * dialled on the throwing cases.
 */

const provider = new HttpProvider({ baseURL: 'http://127.0.0.1:9', dialect: 'anthropic' } as never)

async function run(thinking?: ChatCompletionParams['thinking']): Promise<void> {
	for await (const _chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'hi' }],
		...(thinking ? { thinking } : {}),
	} as ChatCompletionParams)) {
		// drain
	}
}

describe('HttpProvider refuses a thinking request rather than dropping it', () => {
	it('throws on a manual thinking request', async () => {
		await expect(run({ type: 'enabled', budgetTokens: 10_000 })).rejects.toThrow(
			/HttpProvider does not implement thinking/,
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

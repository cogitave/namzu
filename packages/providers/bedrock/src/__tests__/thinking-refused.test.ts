import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { BedrockProvider } from '../client.js'

/**
 * The shared guard's own tests pass whether or not this driver calls it, so
 * this drives the real `chatStream`. The defect being fixed was exactly a
 * declared parameter that no code path consumed — asserting the helper works
 * would have reproduced that shape one level up.
 *
 * The guard runs before any client work, so no credentials and no network are
 * involved: the request never gets that far.
 */

const provider = new BedrockProvider({ region: 'us-east-1' } as never)

async function run(thinking?: ChatCompletionParams['thinking']): Promise<void> {
	for await (const _chunk of provider.chatStream({
		model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
		messages: [{ role: 'user', content: 'hi' }],
		...(thinking ? { thinking } : {}),
	} as ChatCompletionParams)) {
		// drain
	}
}

describe('BedrockProvider refuses a thinking request rather than dropping it', () => {
	it('throws on a manual thinking request', async () => {
		await expect(run({ type: 'enabled', budgetTokens: 10_000 })).rejects.toThrow(
			/BedrockProvider does not implement thinking/,
		)
	})

	it('throws on an adaptive one', async () => {
		await expect(run({ type: 'adaptive' })).rejects.toThrow(/does not implement thinking/)
	})

	it('does not throw for an explicit disable', async () => {
		// Reaches the client and fails on credentials or network instead,
		// which is the point: the guard let it past.
		await expect(run({ type: 'disabled' })).rejects.not.toThrow(/does not implement thinking/)
	})
})

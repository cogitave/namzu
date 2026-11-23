import { resolveContextWindow } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { CodexProvider } from '../index.js'

/**
 * Subscription listing rows as the account lists them. Some state a window, some do not (the
 * backend is not required to). Whatever a row says, no listed id may fall to the SDK's 128k guess.
 */
const LISTED = [
	{ slug: 'gpt-6.2-sol' },
	{ slug: 'gpt-6.2-astra' },
	{ slug: 'gpt-6.1-terra' },
	{ slug: 'gpt-6-luna' },
	{ slug: 'gpt-6-astra-megamode' },
	{ slug: 'gpt-5.6-sol', context_window: 272_000 },
	{ slug: 'gpt-5.6-luna' },
	{ slug: 'gpt-5.6-terra' },
	{ slug: 'gpt-5.5' },
	{ slug: 'gpt-5.5-pro' },
	{ slug: 'gpt-5.4' },
	{ slug: 'gpt-5.4-mini' },
	{ slug: 'gpt-5.2' },
]

describe('every model the subscription route lists has a known window', () => {
	it('resolves none of them to the default', async () => {
		const provider = new CodexProvider({
			accessToken: 't',
			accountId: 'every-listed-account',
		})
		;(provider as unknown as { client: { get: unknown } }).client.get = vi.fn(async () => ({
			models: LISTED,
		}))
		const guessed: string[] = []
		for (const row of LISTED) {
			const reported = await provider.resolveContextWindow(row.slug)
			if (resolveContextWindow(undefined, row.slug, reported).source === 'default')
				guessed.push(row.slug)
		}
		expect(guessed).toEqual([])
	})
})

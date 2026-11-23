import { resolveContextWindow } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { CodexProvider } from '../index.js'

/**
 * Subscription listing rows as the account lists them. A window is whatever the row states; the
 * driver keeps no table of its own and the SDK carries no gpt-6 row, so a row that states nothing
 * is an honest unknown that falls to the default guess (the CLI shows a note for it).
 */
const LISTED = [
	{ slug: 'gpt-6.2-sol', context_window: 500_000 },
	{ slug: 'gpt-6.1-terra', max_context_window: 400_000 },
	{ slug: 'gpt-5.6-sol', context_window: 272_000 },
	{ slug: 'gpt-6-luna' },
	{ slug: 'gpt-6' },
]

describe('the subscription route knows a window only when its listing states one', () => {
	it('resolves stated rows to the provider window and the rest to the default', async () => {
		const provider = new CodexProvider({
			accessToken: 't',
			accountId: 'every-listed-account',
		})
		;(provider as unknown as { client: { get: unknown } }).client.get = vi.fn(async () => ({
			models: LISTED,
		}))
		const sources: Record<string, string> = {}
		for (const row of LISTED) {
			const reported = await provider.resolveContextWindow(row.slug)
			sources[row.slug] = resolveContextWindow(undefined, row.slug, reported).source
		}
		expect(sources).toEqual({
			'gpt-6.2-sol': 'provider',
			'gpt-6.1-terra': 'provider',
			'gpt-5.6-sol': 'provider',
			'gpt-6-luna': 'default',
			'gpt-6': 'default',
		})
	})
})

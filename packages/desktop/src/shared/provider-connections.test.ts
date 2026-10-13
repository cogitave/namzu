import { expect, it } from 'vitest'
import type { ProviderView } from './protocol.js'
import { usableProviders } from './provider-connections.js'

it('counts the keyless Zen free models as usable, as the terminal app does', () => {
	const view: ProviderView = {
		available: [{ id: 'zen', label: 'Zen', defaultModel: 'space-bunny-free', anonymous: true }],
		selected: null,
	}
	expect(usableProviders(view)).toHaveLength(1)
})

it('finds nothing usable only when nothing at all is available', () => {
	expect(usableProviders({ available: [], selected: null })).toEqual([])
})

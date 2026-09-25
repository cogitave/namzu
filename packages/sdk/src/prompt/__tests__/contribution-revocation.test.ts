import { describe, expect, it } from 'vitest'

import { PromptContributionRegistry } from '../contributions.js'

describe('prompt contribution revocation', () => {
	it('removes only the disabled owner and permits its id to be registered again', () => {
		const registry = new PromptContributionRegistry()
		registry.register({ id: 'plugin.alpha', placement: 'context', render: () => 'alpha' })
		registry.register({ id: 'plugin.beta', placement: 'context', render: () => 'beta' })
		expect(registry.unregister('plugin.alpha')).toBe(true)
		expect(registry.render('context', {})).toEqual(['beta'])
		expect(registry.unregister('plugin.alpha')).toBe(false)
		registry.register({ id: 'plugin.alpha', placement: 'context', render: () => 'new alpha' })
		expect(registry.render('context', {})).toEqual(['beta', 'new alpha'])
	})
})

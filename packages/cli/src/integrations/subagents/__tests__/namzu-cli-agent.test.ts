import { describe, expect, it } from 'vitest'

import { NamzuCliAgent } from '../NamzuCliAgent.js'

describe('CLI delegated agent', () => {
	it('keeps its CLI identity on a fresh delegated shell', () => {
		const agent = new NamzuCliAgent({
			id: 'general-purpose',
			name: 'General',
			version: '1.0.0',
			category: 'general',
			description: 'Delegated CLI work.',
		})
		const child = agent.forTurn()
		expect(child).not.toBe(agent)
		expect(child.type).toBe('namzu-cli')
		expect(child.metadata).toMatchObject({ id: 'general-purpose', type: 'namzu-cli' })
	})
})

import { expect, it } from 'vitest'
import { agentStatusWords } from './pane-bodies.js'

it('says who holds an agent tab, in plain words', () => {
	expect(agentStatusWords({ control: 'agent' })).toBe('Namzu is using this tab')
	expect(agentStatusWords({ control: 'agent', working: true })).toBe(
		'Namzu is using this tab · working',
	)
	expect(agentStatusWords({ control: 'person', working: true })).toBe('You have control')
})

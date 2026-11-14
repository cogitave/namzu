import { describe, expect, it } from 'vitest'
import { ZenGoProvider, ZenProvider } from '../client.js'

/** The answer the kernel asks for matches the rule the request path refuses by. */
describe('Zen acceptsForcedToolChoiceFor', () => {
	const go = new ZenGoProvider({ apiKey: 'test-key' })
	const zen = new ZenProvider({ apiKey: 'test-key' })

	it.each(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash', 'mimo-v2'])(
		'Go refuses a forced choice on %s',
		(model) => {
			expect(go.acceptsForcedToolChoiceFor(model)).toBe(false)
		},
	)

	it('Go takes one on a model the rule does not name', () => {
		expect(go.acceptsForcedToolChoiceFor('glm-5.3-flash')).toBe(true)
	})

	it('the Zen service is not affected', () => {
		expect(zen.acceptsForcedToolChoiceFor('deepseek-v4-pro')).toBe(true)
	})
})

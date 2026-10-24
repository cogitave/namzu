import { describe, expect, it } from 'vitest'

import { parseTokenTarget } from '../../integrations/workflows/size.js'
import { typedInputOf } from '../typed-input.js'

describe('the text a token target may come from', () => {
	it('is what the person typed', () => {
		const typed = typedInputOf({ kind: 'human', text: 'audit the repo +500k' })
		expect(parseTokenTarget(typed ?? '')).toBe(500_000)
	})

	it('is the typed command when a slash action expanded it', () => {
		const typed = typedInputOf({
			kind: 'human',
			text: 'Run the long audit with all agents. +9m',
			recallText: '/audit',
		})
		expect(typed).toBe('/audit')
		expect(parseTokenTarget(typed ?? '')).toBeUndefined()
	})

	it.each([
		['a wake-up after a job ended', { kind: 'notice', text: 'The build ended. +500k' }],
		['a peer message', { kind: 'peer', text: 'review this +500k' }],
		['a goal round', { kind: 'goal', text: 'continue +500k' }],
		[
			'a prompt a skill flow composed',
			{ kind: 'human', text: 'save it +500k', skillFlow: true as const },
		],
	])('is nothing for %s, so an injected "+500k" sets no target', (_name, prompt) => {
		const typed = typedInputOf(prompt)
		expect(typed).toBeUndefined()
		expect(parseTokenTarget(typed ?? '')).toBeUndefined()
	})
})

import { describe, expect, it } from 'vitest'

import { agentViewCommandClass } from './agent-view-commands.js'

describe('agentViewCommandClass', () => {
	it('blocks the commands that would change the conversation’s model, and says so', () => {
		expect(agentViewCommandClass('model')).toEqual({
			kind: 'block',
			notice: "/model changes the main conversation's model, not this agent's",
		})
		expect(agentViewCommandClass('fast')).toEqual({
			kind: 'block',
			notice: "/fast changes the main conversation's fast mode, not this agent's",
		})
	})

	it('asks before the commands that act on the conversation’s history', () => {
		for (const name of ['compact', 'clear', 'new', 'rewind']) {
			expect(agentViewCommandClass(name)).toEqual({
				kind: 'confirm',
				title: `/${name} acts on the main conversation, not this agent`,
				confirmLabel: `Run /${name} on the main conversation`,
			})
		}
	})

	it('lets every other command run against the conversation', () => {
		for (const name of ['help', 'cost', 'agents', 'permissions', 'status']) {
			expect(agentViewCommandClass(name)).toBeUndefined()
		}
	})
})

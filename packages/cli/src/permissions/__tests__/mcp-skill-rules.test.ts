/**
 * A skill a tool server offers is named `server:skill`, and the ordinary
 * `Skill(...)` rules decide it. Driven through the kernel's own gate.
 */

import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { parseRuleString } from '../rule-strings.js'
import { compilePermissions } from '../rules.js'

function decide(config: Parameters<typeof compilePermissions>[0], name: string) {
	const { rules } = compilePermissions(config)
	const gate = new AuthorizationGate(
		{
			enabled: true,
			rules: [...rules],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)
	return gate.evaluate({ toolName: 'skill', toolInput: { name }, toolDef: undefined }).decision
}

describe('rules for a skill from a tool server', () => {
	it('deny the one named and leave the server’s others to the usual review', () => {
		const config = { skill: { 'tickets:triage': 'deny' } } as const
		expect(decide(config, 'tickets:triage')).toBe('deny')
		expect(decide(config, 'tickets:audit')).toBe('review')
	})

	it('can deny every skill of one server by its prefix', () => {
		const config = { skill: { 'tickets:*': 'deny' } } as const
		expect(decide(config, 'tickets:audit')).toBe('deny')
		expect(decide(config, 'other:audit')).toBe('review')
	})

	it('read the Skill(server:name) spelling as the same rule', () => {
		expect(parseRuleString('Skill(tickets:triage)')).toEqual({
			tool: 'skill',
			specifier: 'tickets:triage',
		})
	})
})

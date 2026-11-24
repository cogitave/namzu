import { teammateNameProblem } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { agentNameProblem } from './agent-names.js'

// A name that starts a teammate is judged by the teams module's own rule, so the two cannot drift.

const SAMPLES = [
	'alice',
	'A1',
	'-lead',
	'has space',
	'x'.repeat(65),
	'main',
	'user',
	'system',
	'team-lead',
	'lead',
	'0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
	'w0abc1234',
	'ok_name-2',
	'',
]

describe('agent names', () => {
	it('a teammate name is judged exactly as the teams module judges it', () => {
		for (const name of SAMPLES)
			expect(agentNameProblem(name, { team: true }), JSON.stringify(name)).toBe(
				teammateNameProblem(name),
			)
	})

	it('a plain sub-agent name differs only in that `lead` is not reserved', () => {
		for (const name of SAMPLES) {
			const plain = agentNameProblem(name)
			const team = agentNameProblem(name, { team: true })
			if (name === 'lead') {
				expect(plain).toBeUndefined()
				expect(team).toContain('reserved')
			} else {
				// Same verdict; the reserved-word text names a different way to reach the main conversation.
				expect(plain === undefined).toBe(team === undefined)
			}
		}
	})
})

import { describe, expect, it } from 'vitest'

import { isPlanFileWrite } from '../plan-file.js'

const PLAN = '/home/u/.namzu/projects/p/s/plans/plan.md'
const isPlan = isPlanFileWrite(PLAN, '/work/repo')
const call = (name: string, path: unknown) => ({ name, input: { path } })

describe('which call writes the plan file', () => {
	it('accepts write and edit of exactly that file, by any spelling of the path', () => {
		expect(isPlan(call('write', PLAN))).toBe(true)
		expect(isPlan(call('edit', PLAN))).toBe(true)
		expect(isPlan(call('write', '../../home/u/.namzu/projects/p/s/plans/../plans/plan.md'))).toBe(
			true,
		)
		expect(
			isPlanFileWrite('/work/repo/plans/plan.md', '/work/repo')(call('write', 'plans/plan.md')),
		).toBe(true)
	})

	it('refuses a neighbour, a prefix, another tool and a malformed call', () => {
		expect(isPlan(call('write', `${PLAN}.bak`))).toBe(false)
		expect(isPlan(call('write', '/home/u/.namzu/projects/p/s/plans/other.md'))).toBe(false)
		expect(isPlan(call('write', '/home/u/.namzu/projects/p/s/plans'))).toBe(false)
		expect(isPlan(call('bash', PLAN))).toBe(false)
		expect(isPlan(call('write', ''))).toBe(false)
		expect(isPlan(call('write', 42))).toBe(false)
		expect(isPlan({ name: 'write', input: null })).toBe(false)
		expect(isPlan(call('write', `${PLAN}\0`))).toBe(false)
	})
})

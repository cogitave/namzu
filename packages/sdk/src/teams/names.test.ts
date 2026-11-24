import { describe, expect, it } from 'vitest'
import { normalizeTeamName, teamNameProblem, teammateNameProblem } from './names.js'

describe('teammate names', () => {
	it('take letters, digits, underscore and hyphen', () => {
		for (const ok of ['alice', 'A1', 'db_worker', 'a-b-c', 'x'.repeat(64)])
			expect(teammateNameProblem(ok), ok).toBeUndefined()
	})

	it('refuse other shapes and lengths', () => {
		for (const bad of ['', '-a', '_a', 'a b', 'a/b', 'a.b', 'é', 'x'.repeat(65), '../x'])
			expect(teammateNameProblem(bad), bad).toMatch(/name must start/u)
	})

	it('reserve the names that already address something, however they are spelled', () => {
		for (const reserved of ['lead', 'Lead', 'main', 'user', 'system', 'team-lead', 'ＬＥＡＤ'])
			expect(teammateNameProblem(reserved), reserved).toBeDefined()
	})

	it('refuse a name shaped like a task or run id', () => {
		expect(teammateNameProblem('0b6f8e0a-1111-4222-8333-444455556666')).toMatch(/task or run id/u)
		expect(teammateNameProblem('w1a2b3c4d')).toMatch(/task or run id/u)
	})

	it('are told apart after folding', () => {
		expect(normalizeTeamName(' Alice ')).toBe('alice')
		expect(normalizeTeamName('a  b')).toBe('a-b')
	})
})

describe('team names', () => {
	it('are safe directory names', () => {
		expect(teamNameProblem('team-0a1b2c3d')).toBeUndefined()
		for (const bad of ['', '.', '..', 'a/b', '../x', 'a\\b', '-x'])
			expect(teamNameProblem(bad), bad).toBeDefined()
	})
})

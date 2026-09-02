import { describe, expect, it } from 'vitest'

import { type SlashContext, runSlash } from '../slashCommands.js'

const ctx = { cwd: '/tmp', jobs: () => [], compaction: null } as unknown as SlashContext

describe('/restore', () => {
	it('lists with no argument and restores a turn number', () => {
		expect(runSlash('/restore', ctx)).toEqual({ kind: 'restore' })
		expect(runSlash('/restore 3', ctx)).toEqual({ kind: 'restore', turn: 3 })
	})

	it('refuses anything that is not a turn number', () => {
		for (const bad of ['/restore 0', '/restore two', '/restore 1.5', '/restore -1']) {
			const action = runSlash(bad, ctx)
			expect(action?.kind).toBe('message')
		}
	})
})

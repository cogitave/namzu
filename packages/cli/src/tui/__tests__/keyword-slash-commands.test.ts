import { describe, expect, it } from 'vitest'

import { type SlashContext, matchSlashCommands, parseSlash, runSlash } from '../slashCommands.js'

const ctx = {
	cwd: '/tmp',
	jobs: () => [],
	compaction: null,
	userCommands: [],
} as unknown as SlashContext

const text = (line: string): string => {
	const action = runSlash(line, ctx)
	return action?.kind === 'message' ? action.content : ''
}

describe('slash commands are spelled as keywords', () => {
	it('reads a second word as part of the command name', () => {
		expect(parseSlash('/add dir ../x')).toEqual({ name: 'add dir', args: ['../x'] })
		expect(parseSlash('/terminal setup')).toEqual({ name: 'terminal setup', args: [] })
		expect(parseSlash('/release notes 1.0')).toEqual({ name: 'release notes', args: ['1.0'] })
	})

	it('offers the keyword form in the palette', () => {
		expect(matchSlashCommands('/add').map((c) => c.name)).toContain('add dir')
		expect(matchSlashCommands('/release n').map((c) => c.name)).toEqual(['release notes'])
		expect(matchSlashCommands('/terminal').map((c) => c.name)).toEqual(['terminal setup'])
	})

	it('answers a first word alone with the usage of its second word', () => {
		expect(text('/terminal')).toBe('Usage: /terminal setup')
		expect(text('/add')).toBe('Usage: /add dir [path]')
	})

	it('runs nothing for an old hyphenated spelling and names the new one', () => {
		expect(text('/add-dir ../x')).toBe('This command is now `/add dir`.')
		expect(text('/release-notes')).toBe('This command is now `/release notes`.')
		expect(text('/terminal-setup')).toBe('This command is now `/terminal setup`.')
	})
})

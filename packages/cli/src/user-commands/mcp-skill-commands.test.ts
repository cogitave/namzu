import { describe, expect, it } from 'vitest'

import { matchSlashCommands } from '../tui/slashCommands.js'
import { withMcpSkillCommands } from './mcp-skill-commands.js'
import { type UserCommand, expandCommand } from './store.js'

const own = (name: string): UserCommand => ({
	name,
	description: 'mine',
	template: 'do it',
	path: `/x/${name}.md`,
	source: 'user',
})

describe('server skills in the / menu', () => {
	const items = [
		{ name: 'tickets:triage', description: 'Sort tickets' },
		{ name: 'tickets:b/review', description: 'a qualified form' },
	]

	it('adds each one-word name, sends the model to the skill tool, and passes what was typed', () => {
		const commands = withMcpSkillCommands([own('deploy')], items)
		expect(commands.map((c) => c.name)).toEqual(['deploy', 'tickets:triage'])
		const triage = commands.find((c) => c.name === 'tickets:triage')
		const expanded = triage ? expandCommand(triage, 'last week') : undefined
		expect(expanded).toEqual({
			ok: true,
			prompt:
				'Load the skill "tickets:triage" with the skill tool and follow it for this: last week',
		})
	})

	it('replaces its own earlier entries and never a command another source holds', () => {
		const first = withMcpSkillCommands([own('tickets:triage')], items)
		expect(first.filter((c) => c.name === 'tickets:triage')).toHaveLength(1)
		expect(first[0]?.source).toBe('user')
		const swapped = withMcpSkillCommands(withMcpSkillCommands([own('deploy')], items), [
			{ name: 'tickets:audit', description: 'Audit' },
		])
		expect(swapped.map((c) => c.name)).toEqual(['deploy', 'tickets:audit'])
	})

	it('is found by typing the server name and a colon', () => {
		const commands = withMcpSkillCommands([], items)
		expect(matchSlashCommands('/tickets:', commands, []).map((c) => c.name)).toEqual([
			'tickets:triage',
		])
		expect(matchSlashCommands('/tick', commands, []).map((c) => c.name)).toEqual(['tickets:triage'])
	})
})

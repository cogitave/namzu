import { describe, expect, it } from 'vitest'

import { splitToolList, toolFlagLayers, toolListTable } from '../tool-flags.js'

describe('splitToolList', () => {
	it('splits on commas and spaces but not inside brackets', () => {
		expect(splitToolList('edit, bash(git status*) write').items).toEqual([
			'edit',
			'bash(git status*)',
			'write',
		])
		expect(splitToolList('bash(a, b) read').items).toEqual(['bash(a, b)', 'read'])
	})

	it('reports an unclosed bracket', () => {
		expect(splitToolList('bash(git status').unbalanced).toBe(true)
		expect(splitToolList('bash(git status)').unbalanced).toBe(false)
	})
})

describe('toolListTable', () => {
	it('makes a bare name cover every call and a bracketed entry a pattern', () => {
		const { table, problems } = toolListTable(
			'--allowed-tools',
			['edit bash(git status*) bash(npm test)'],
			'allow',
		)
		expect(problems).toEqual([])
		expect(table).toEqual({
			edit: 'allow',
			bash: { 'git status*': 'allow', 'npm test': 'allow' },
		})
	})

	it('keeps a pattern named beside a bare name of the same tool', () => {
		const { table } = toolListTable('--disallowed-tools', ['bash(rm *)', 'bash'], 'deny')
		expect(table).toEqual({ bash: { 'rm *': 'deny', '*': 'deny' } })
	})

	it('writes built-in names in lower case and leaves a server tool exactly as given', () => {
		const { table } = toolListTable('--allowed-tools', ['Edit mcp__Files__Read'], 'allow')
		expect(table).toEqual({ edit: 'allow', mcp__Files__Read: 'allow' })
	})

	it('names the entry it cannot read instead of dropping it', () => {
		const { table, problems } = toolListTable('--allowed-tools', ['bash(rm *'], 'allow')
		expect(table).toBeUndefined()
		expect(problems[0]).toMatchObject({ flag: '--allowed-tools' })
	})

	it('has no table for an empty list', () => {
		expect(toolListTable('--allowed-tools', [], 'allow').table).toBeUndefined()
	})
})

describe('toolFlagLayers', () => {
	it('gives the allow layer first and the deny layer second', () => {
		const { layers } = toolFlagLayers({ allowedTools: ['edit'], disallowedTools: ['bash'] })
		expect(layers).toEqual([{ edit: 'allow' }, { bash: 'deny' }])
	})
})

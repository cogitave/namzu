import { describe, expect, it } from 'vitest'

import { renderHooks } from '../slashCommands.js'

/**
 * `/hooks` says which hooks skills have attached, by the skill's name, and
 * which skills carry hooks that attach when they are used.
 */
describe('/hooks and skills', () => {
	const attached = {
		skill: 'guarded',
		event: 'pre_tool_use',
		runs: 'node guard.mjs',
		matcher: 'Bash',
		once: false,
		scope: 'conversation' as const,
	}

	it('lists the hooks a skill attached, with its name and how long they last', () => {
		const text = renderHooks(undefined, {
			skillHooks: { attached: [attached], carriers: ['guarded'] },
		})
		expect(text).toContain('skill hooks (set by a skill, attached while it is in use)')
		expect(text).toContain(
			'  pre_tool_use: node guard.mjs · matches Bash · skill guarded, for this conversation',
		)
		expect(text).not.toContain('No hooks')
	})

	it('says a forked skill’s hooks last while its delegated agent runs', () => {
		const text = renderHooks(undefined, {
			skillHooks: { attached: [{ ...attached, scope: 'agent', once: true }], carriers: [] },
		})
		expect(text).toContain('· once · skill guarded, while its delegated agent runs')
	})

	it('says a skill that carries hooks and has not been used attaches them when it is used', () => {
		const text = renderHooks(undefined, { skillHooks: { attached: [], carriers: ['a', 'b'] } })
		expect(text).toContain('a, b carry hooks that attach when the skill is used.')
		expect(text).not.toContain('No hooks')
	})

	it('does not list a skill as waiting once it has attached', () => {
		const text = renderHooks(undefined, {
			skillHooks: { attached: [attached], carriers: ['guarded', 'other'] },
		})
		expect(text).toContain('other carries hooks that attach when the skill is used.')
		expect(text).not.toContain('guarded carries')
	})

	it('says a switch keeps them from attaching', () => {
		const text = renderHooks(undefined, {
			switch: 'disabled',
			skillHooks: { attached: [], carriers: ['guarded'] },
		})
		expect(text).toContain(
			'skill hooks are switched off: guarded carries hooks that do not attach.',
		)
	})

	it('says nothing about skills when none carries hooks', () => {
		const text = renderHooks(undefined, { skillHooks: { attached: [], carriers: [] } })
		expect(text).toContain('No hooks')
	})
})

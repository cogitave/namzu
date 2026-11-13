import { describe, expect, it } from 'vitest'

import { renderHooks } from '../slashCommands.js'

/**
 * `/hooks` says which hooks agents’ runs have attached while they run, by the
 * agent’s name, which agent files carry hooks, and which files are not offered.
 */
describe('/hooks and agent files', () => {
	const attached = {
		agent: 'guarded',
		event: 'pre_tool_use',
		runs: 'node guard.mjs',
		matcher: 'Bash',
		once: false,
		session: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5c',
	}

	it('lists the hooks a live run attached, with the agent’s name', () => {
		const text = renderHooks(undefined, {
			agentHooks: { attached: [attached], carriers: ['guarded'], refused: [] },
		})
		expect(text).toContain('agent hooks (set by an agent file, attached while its agent runs)')
		expect(text).toContain(
			'  pre_tool_use: node guard.mjs · matches Bash · agent guarded, run 0190a5b2',
		)
		expect(text).not.toContain('No hooks')
	})

	it('names agent files that carry hooks and have no live run', () => {
		const text = renderHooks(undefined, {
			agentHooks: { attached: [], carriers: ['a', 'b'], refused: [] },
		})
		expect(text).toContain('a, b carry hooks that attach to each run of the agent.')
	})

	it('names a file that is not offered, with its own line', () => {
		const line =
			'Agent "broken" is not offered: /p/broken.md, hooks: PreToolUse group 1, hook 1 cannot be read.'
		const text = renderHooks(undefined, {
			agentHooks: { attached: [], carriers: ['broken'], refused: [{ name: 'broken', line }] },
		})
		expect(text).toContain(line)
	})

	it('says a switch keeps them from attaching', () => {
		const text = renderHooks(undefined, {
			switch: 'disabled',
			agentHooks: { attached: [], carriers: ['guarded'], refused: [] },
		})
		expect(text).toContain(
			'agent hooks are switched off: guarded carries hooks that do not attach.',
		)
	})
})

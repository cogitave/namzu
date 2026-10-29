import { type CommandShell, createRuntimeContextMessage } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { environmentReminders } from '../../reminders/environment.js'
import {
	type EnvironmentProbe,
	composeEnvironmentPrompt,
	environmentFactLines,
	readEnvironmentFacts,
} from '../environment.js'

const shell: CommandShell = { path: '/tools/bash', dialect: 'bash', source: 'bash' }
const now = new Date(2026, 9, 28, 12)

function probe(outputs: readonly (string | null)[]): EnvironmentProbe {
	return {
		git: vi.fn(async (_cwd, args) => {
			if (args.includes('--is-inside-work-tree')) return outputs[0] ?? null
			if (args.includes('--short')) return outputs[1] ?? null
			if (args.includes('--absolute-git-dir')) return outputs[2] ?? null
			if (args.includes('--git-common-dir')) return outputs[3] ?? null
			throw new Error(`Unexpected git probe: ${args.join(' ')}`)
		}),
		osVersion: () => 'Linux 6.12-test',
		executionShell: () => shell,
	}
}

describe('observed execution environment', () => {
	it('uses the command execution resolver and OS observation, not a login shell or guessed distro', async () => {
		const facts = await readEnvironmentFacts('/repo', now, probe(['true', 'main', '.git', '.git']))
		expect(facts.executionShell).toEqual(shell)
		expect(facts.osVersion).toBe('Linux 6.12-test')
		const prompt = composeEnvironmentPrompt(facts, { stable: true })
		expect(prompt).toContain('Host execution shell: `/tools/bash` (bash dialect).')
		expect(prompt).toContain('Host OS version: Linux 6.12-test.')
		expect(prompt).not.toContain("Today's date")
		expect(prompt).not.toMatch(/Ubuntu|macOS|zsh/)
	})

	it('does not present the host shell as the sandbox guest shell', async () => {
		const facts = await readEnvironmentFacts('/repo', now, probe([null, null, null, null]))
		const prompt = composeEnvironmentPrompt({
			...facts,
			boundary: {
				sandbox: { environment: 'linux-bwrap', enforced: ['filesystem'] },
				escape: 'refused',
				interactive: false,
			},
		})
		expect(prompt).toContain('Inside the sandbox, commands use bash if the guest has it')
		expect(prompt).toContain('host shell above applies only to host execution')
	})

	it('names the platform shell without inventing an executable path', async () => {
		const facts = await readEnvironmentFacts('/repo', now, {
			...probe([null, null, null, null]),
			executionShell: () => ({ path: undefined, dialect: 'cmd', source: 'platform' }),
		})
		expect(composeEnvironmentPrompt(facts)).toContain(
			'Host execution shell: the platform command shell (cmd dialect).',
		)
	})

	it('recognizes a linked worktree by its distinct administration and common directories', async () => {
		const source = probe(['true', 'topic', '/repo/.git/worktrees/topic', '/repo/.git'])
		const facts = await readEnvironmentFacts('/work/topic', now, source)
		expect(facts.linkedWorktree).toBe(true)
		expect(environmentFactLines(facts).join('\n')).toContain('This is a linked git worktree')
		expect(composeEnvironmentPrompt(facts, { stable: true })).not.toContain('linked git worktree')
		expect(source.git).toHaveBeenCalledTimes(4)
		const notices = environmentReminders({ messages: [], facts })
		expect(notices[0]).toContain('This is a linked git worktree')
		expect(
			environmentReminders({
				messages: notices.map((text) => createRuntimeContextMessage(text, 'reminder')),
				facts,
			}),
		).toEqual([])
	})

	it.each([
		['ordinary repository', ['true', 'main', '.git', './.git'], false],
		['separate git directory', ['true', 'main', '/metadata/repo', '/metadata/repo'], false],
		['unavailable common directory', ['true', 'main', '/repo/.git', null], undefined],
		['not a repository', [null, null, null, null], undefined],
	] as const)('does not invent a linked worktree for %s', async (_label, output, expected) => {
		const facts = await readEnvironmentFacts('/repo', now, probe(output))
		expect(facts.linkedWorktree).toBe(expected)
		expect(environmentFactLines(facts).join('\n')).not.toContain('linked git worktree')
	})
})

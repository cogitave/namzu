import { describe, expect, it } from 'vitest'

import { outcomeOf, skillShellAllow } from './inline-shell-host.js'

describe('outcomeOf', () => {
	it.each([
		[
			'a success with both streams',
			{ success: true, output: 'STDOUT:\na\n\nSTDERR:\nb', data: { exitCode: 0 } },
			{ kind: 'ran', stdout: 'a', stderr: 'b', exitCode: 0 },
		],
		[
			'a success with no output',
			{ success: true, output: '(no output)', data: { exitCode: 0 } },
			{ kind: 'ran', stdout: '', stderr: '', exitCode: 0 },
		],
		[
			'a command the tool counts as answered, with its own status',
			{ success: true, output: 'STDOUT:\nnone', data: { exitCode: 1 } },
			{ kind: 'ran', stdout: 'none', stderr: '', exitCode: 1 },
		],
		[
			'a failure read straight from the tool: the text is in output',
			{
				success: false,
				output: 'STDERR:\nnope',
				error: 'Command exited with code 3',
				data: { exitCode: 3, timedOut: false },
			},
			{ kind: 'ran', stdout: '', stderr: 'nope', exitCode: 3 },
		],
		[
			'a failure read through a nested dispatch: the text is in error',
			{
				success: false,
				output: '',
				error: 'STDOUT:\nhalf\n\nError: Command exited with code 2',
				data: { exitCode: 2, timedOut: false },
			},
			{ kind: 'ran', stdout: 'half', stderr: '', exitCode: 2 },
		],
		[
			'a command that could not report an exit code keeps the tool’s own words',
			{ success: false, output: '', error: 'Command failed: spawn', data: { timedOut: false } },
			{ kind: 'ran', stdout: 'Command failed: spawn', stderr: '', exitCode: null },
		],
		[
			'a refusal by the permission rules',
			{
				success: false,
				output: '',
				error:
					'Error: Tool "bash" was not executed. Blocked by the authorization gate: denied by name (bash)',
			},
			{ kind: 'denied', reason: 'Blocked by the authorization gate: denied by name (bash)' },
		],
	])('%s', (_name, result, expected) => {
		expect(outcomeOf(result)).toEqual(expected)
	})
})

describe('skillShellAllow', () => {
	const call = (command: string) => ({ name: 'bash', input: { command } })

	it('is absent when the skill grants the shell tool nothing', () => {
		expect(skillShellAllow(undefined)).toBeUndefined()
		expect(skillShellAllow([])).toBeUndefined()
		expect(skillShellAllow(['Read', 'Grep'])).toBeUndefined()
	})

	it('covers every command for a whole-tool entry', () => {
		const allow = skillShellAllow(['Bash'])
		expect(allow?.(call('anything'))).toBe(true)
	})

	it('covers only the commands a pattern names', () => {
		const allow = skillShellAllow(['Bash(git status *)', 'Read'])
		expect(allow?.(call('git status -s'))).toBe(true)
		expect(allow?.(call('git status'))).toBe(true)
		expect(allow?.(call('git push'))).toBe(false)
		expect(allow?.(call('git status && git push'))).toBe(false)
		expect(allow?.(call('git status > ~/.bashrc'))).toBe(false)
	})

	it('does not cover another tool', () => {
		expect(skillShellAllow(['Bash'])?.({ name: 'write', input: { path: 'x' } })).toBe(false)
	})

	it('puts the skill’s folder into a pattern that names it', () => {
		const allow = skillShellAllow(['Bash(${NAMZU_SKILL_DIR}/run.sh *)'], {
			skillDirectory: '/skills/ship',
		})
		expect(allow?.(call('/skills/ship/run.sh now'))).toBe(true)
		expect(allow?.(call('/other/run.sh now'))).toBe(false)
		expect(skillShellAllow(['Bash(${NAMZU_SKILL_DIR}/run.sh *)'])).toBeUndefined()
	})
})

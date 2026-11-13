/**
 * The variables a moved hook command expects: the `..._PROJECT_DIR` rule read
 * by the shape of the name, the entry's `env` map, and the sentence a "not
 * found" failure carries when the command refers to a variable set nowhere.
 */

import { describe, expect, it } from 'vitest'

import {
	expandHookEnvValue,
	hookUnsetVariableHint,
	movedEnvironment,
	referencedVariables,
	shellHookEnvNameProblem,
	shellHookEnvProblems,
} from '../shell-hook-env.js'
import { runShellHook, shellHookVerdict } from '../shell-hook.js'

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'
const input = { event: 'turn_start', sessionId: SESSION, cwd: process.cwd() } as const

// The real child processes here are `sh -c 'printf ...'`: milliseconds, and
// the suite's own per-test limit catches a genuine hang.
async function printed(command: string, extra: Record<string, unknown> = {}, projectDir = '/proj') {
	const outcome = await runShellHook({ command, ...extra }, { ...input, projectDir })
	return outcome
}

describe('referencedVariables', () => {
	it('reads $NAME and ${NAME} in order and once', () => {
		expect(referencedVariables(['"$A_DIR"/x', '${B_DIR}/y $A_DIR'])).toEqual(['A_DIR', 'B_DIR'])
	})

	it('leaves out a reference that carries its own default, unless asked', () => {
		expect(referencedVariables(['${A:-x} ${B-y} ${C:+z} ${D=w} ${E:?no}'])).toEqual(['E'])
		expect(referencedVariables(['${A:-x}'], { withDefaults: true })).toEqual(['A'])
	})

	it('ignores positional and special parameters', () => {
		expect(referencedVariables(['$1 $? $$ $@ $* ${#}'])).toEqual([])
	})
})

describe('env names and values', () => {
	it('accepts ordinary names and refuses the rest, naming why', () => {
		expect(shellHookEnvNameProblem('MY_DIR_2')).toBeUndefined()
		expect(shellHookEnvNameProblem('2BAD')).toMatch(/not a valid variable name/)
		expect(shellHookEnvNameProblem('A-B')).toMatch(/not a valid variable name/)
		expect(shellHookEnvNameProblem('')).toMatch(/not a valid variable name/)
		expect(shellHookEnvNameProblem('NAMZU_PROJECT_DIR')).toMatch(/cannot be replaced/)
	})

	it('reports a map that is not a map, and values that are not text', () => {
		expect(shellHookEnvProblems(['a'])).toEqual(['must be a mapping of variable names to text'])
		expect(shellHookEnvProblems('x')).toHaveLength(1)
		expect(shellHookEnvProblems({ OK: 'x', N: 3 })).toEqual(['"N" must be text'])
		expect(shellHookEnvProblems({ OK: 'x' })).toEqual([])
	})

	it('fills only what the hook already has and leaves other text as written', () => {
		const have = { NAMZU_PROJECT_DIR: '/p', EMPTY: '' }
		expect(expandHookEnvValue('${NAMZU_PROJECT_DIR}/a:$NAMZU_PROJECT_DIR/b', have)).toBe(
			'/p/a:/p/b',
		)
		expect(expandHookEnvValue('$NOPE/${NOPE2}/$EMPTY/x', have)).toBe('$NOPE/${NOPE2}//x')
	})
})

describe('movedEnvironment', () => {
	const kernel = { NAMZU_PROJECT_DIR: '/proj', NAMZU_HOOK_EVENT: 'turn_start' }
	const folders = { project: '/proj' } as const

	it('starts an entry that refers to no variable with exactly the environment it had', () => {
		const base = { PATH: '/bin', HOME: '/h', ...kernel }
		const moved = movedEnvironment({ command: '/bin/true --flag' }, base, kernel, folders)
		expect(moved.env).toEqual(base)
		expect(moved.unset).toEqual([])
	})

	it('sets an unset name ending in _PROJECT_DIR to the project folder', () => {
		const moved = movedEnvironment(
			{ command: '"$ANYTOOL_PROJECT_DIR"/.hooks/check.sh', args: ['${OTHER_PROJECT_DIR}'] },
			{ ...kernel },
			kernel,
			folders,
		)
		expect(moved.env.ANYTOOL_PROJECT_DIR).toBe('/proj')
		expect(moved.env.OTHER_PROJECT_DIR).toBe('/proj')
		expect(moved.unset).toEqual([])
	})

	it('never overwrites a name already set, even to empty', () => {
		const moved = movedEnvironment(
			{ command: '$A_PROJECT_DIR $B_PROJECT_DIR' },
			{ ...kernel, A_PROJECT_DIR: '/mine', B_PROJECT_DIR: '' },
			kernel,
			folders,
		)
		expect(moved.env.A_PROJECT_DIR).toBe('/mine')
		expect(moved.env.B_PROJECT_DIR).toBe('')
	})

	it('does not read a name that only contains the ending', () => {
		const moved = movedEnvironment(
			{ command: '$PROJECT_DIR $X_PROJECT_DIRS $_PROJECT_DIR' },
			{ ...kernel },
			kernel,
			folders,
		)
		expect(moved.env.PROJECT_DIR).toBeUndefined()
		expect(moved.env.X_PROJECT_DIRS).toBeUndefined()
		expect(moved.env._PROJECT_DIR).toBe('/proj')
		expect(moved.unset).toEqual(['PROJECT_DIR', 'X_PROJECT_DIRS'])
	})

	it('lets env override an inherited value, fills from the hook environment, and keeps the kernel names', () => {
		const moved = movedEnvironment(
			{
				command: 'x',
				env: {
					TOOL_HOME: '${NAMZU_PROJECT_DIR}/.tool',
					PATH: '/mine:$PATH',
					NAMZU_HOOK_EVENT: 'x',
				},
			},
			{ PATH: '/bin', TOOL_HOME: '/inherited', ...kernel },
			kernel,
			folders,
		)
		expect(moved.env.TOOL_HOME).toBe('/proj/.tool')
		expect(moved.env.PATH).toBe('/mine:/bin')
		expect(moved.env.NAMZU_HOOK_EVENT).toBe('turn_start')
	})

	it('skips an env name or value that cannot be used instead of throwing', () => {
		const moved = movedEnvironment(
			{ command: 'x', env: { 'A-B': 'x', OK: 'y', N: 3 } as never },
			{ ...kernel },
			kernel,
			folders,
		)
		expect(moved.env.OK).toBe('y')
		expect(moved.env['A-B']).toBeUndefined()
		expect(moved.env.N).toBeUndefined()
	})

	it('lists the other unset names, but not ones the command assigns or that env supplies', () => {
		const moved = movedEnvironment(
			{
				command: 'FOO=1; for I in a; do echo $FOO $I $SUPPLIED $MISSING_DIR; done',
				env: { SUPPLIED: 's' },
			},
			{ ...kernel },
			kernel,
			folders,
		)
		expect(moved.unset).toEqual(['MISSING_DIR'])
	})
})

describe('a real run', () => {
	it('gives a command written for another tool the project folder', async () => {
		const outcome = await printed('printf %s "$SOMETOOL_PROJECT_DIR"')
		expect(outcome.stdout).toBe('/proj')
	})

	it('reads the name in the arguments of the exec form too', async () => {
		const outcome = await runShellHook(
			{ command: 'printenv', args: ['SOMETOOL_PROJECT_DIR', '$SOMETOOL_PROJECT_DIR'] },
			{ ...input, projectDir: '/proj' },
		)
		// `printenv` is given the literal text `$SOMETOOL_PROJECT_DIR` as a second
		// name, which is not a variable; the first is read from the environment.
		expect(outcome.stdout.split('\n')[0]).toBe('/proj')
	})

	it('passes the entry env to the command', async () => {
		const outcome = await printed('printf %s "$MY_FLAG:$MY_DIR"', {
			env: { MY_FLAG: 'on', MY_DIR: '${NAMZU_PROJECT_DIR}/sub' },
		})
		expect(outcome.stdout).toBe('on:/proj/sub')
	})

	it('does not let env change what the kernel sets', async () => {
		const outcome = await printed('printf %s "$NAMZU_PROJECT_DIR"', {
			env: { NAMZU_PROJECT_DIR: '/elsewhere' },
		})
		expect(outcome.stdout).toBe('/proj')
	})

	it('reports the variables a missing script path refers to', async () => {
		const outcome = await printed('"$UNSET_TOOL_HOME/run.sh"')
		expect(outcome.exitCode).toBe(127)
		expect(outcome.unsetVariables).toEqual(['UNSET_TOOL_HOME'])
	})

	it('carries no unset list for a command that refers to nothing unset', async () => {
		const outcome = await printed('exit 3')
		expect(outcome.unsetVariables).toBeUndefined()
	})
})

describe('the failure line', () => {
	const entry = { command: '"$UNSET_TOOL_HOME/run.sh"' }
	const notFound = {
		exitCode: 127,
		timedOut: false,
		stdout: '',
		stderr: 'sh: 1: /run.sh: not found',
		unsetVariables: ['UNSET_TOOL_HOME'],
	}

	it('names the variable and the env key when the program was not found', () => {
		expect(hookUnsetVariableHint(notFound)).toBe(
			'its command refers to $UNSET_TOOL_HOME, which is not set for hooks: give it a value with the entry\'s "env" key',
		)
	})

	it('also reads a spawn error and a "no such file" in stderr, and stays quiet otherwise', () => {
		const base = { ...notFound, exitCode: 1, stderr: '' }
		expect(hookUnsetVariableHint({ ...base, spawnError: 'spawn x ENOENT' })).toBeDefined()
		expect(
			hookUnsetVariableHint({ ...base, stderr: 'cat: /x: No such file or directory' }),
		).toBeDefined()
		expect(hookUnsetVariableHint(base)).toBeUndefined()
		expect(hookUnsetVariableHint({ ...notFound, unsetVariables: [] })).toBeUndefined()
	})

	it('puts the sentence in the reason a blocking entry gives, and in a notice when it carries on', () => {
		const blocking = shellHookVerdict('pre_tool_use', { ...entry, onFailure: 'block' }, notFound)
		expect(blocking).toMatchObject({ action: 'skip' })
		expect((blocking as { reason: string }).reason).toContain('$UNSET_TOOL_HOME')
		expect((blocking as { reason: string }).reason).toContain('"env"')
		const carrying = shellHookVerdict('pre_tool_use', entry, notFound)
		expect(carrying).toMatchObject({ action: 'continue' })
		expect((carrying as { notice: string }).notice).toContain('"env"')
	})

	it('leaves a failure with no unset variable exactly as it was', () => {
		expect(
			shellHookVerdict('pre_tool_use', entry, { ...notFound, unsetVariables: undefined }),
		).toEqual({ action: 'continue' })
	})
})

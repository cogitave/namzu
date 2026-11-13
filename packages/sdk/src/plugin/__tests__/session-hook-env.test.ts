/**
 * The variables a hook sets for later commands: which lines are read (as
 * data, never run), which names are refused, and how the three kinds of hook
 * layer.
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
	MAX_HOOK_ENV_FILE_BYTES,
	MAX_HOOK_ENV_VALUE_CHARS,
	MAX_HOOK_ENV_VARIABLES,
	SessionHookEnv,
	readHookEnvLine,
	refusedHookEnvName,
} from '../session-hook-env.js'

const read = (line: string, names: Record<string, string> = {}) =>
	readHookEnvLine(line, (name) => names[name] ?? '')

describe('one line of a hook file', () => {
	it('reads export NAME=value and NAME=value', () => {
		expect(read('export FOO=bar')).toEqual({ ok: { name: 'FOO', value: 'bar' } })
		expect(read('FOO=bar')).toEqual({ ok: { name: 'FOO', value: 'bar' } })
		expect(read('  export   FOO=bar  ')).toEqual({ ok: { name: 'FOO', value: 'bar' } })
		expect(read('FOO=')).toEqual({ ok: { name: 'FOO', value: '' } })
	})

	it('skips blank lines, comments and a bare export', () => {
		expect(read('')).toEqual({ skip: true })
		expect(read('# note')).toEqual({ skip: true })
		expect(read('export FOO')).toEqual({ skip: true })
	})

	it('reads single quotes literally and double quotes with their escapes', () => {
		expect(read(`FOO='a $B $(x) b'`)).toEqual({ ok: { name: 'FOO', value: 'a $B $(x) b' } })
		expect(read('FOO="a \\"q\\" \\$B"')).toEqual({ ok: { name: 'FOO', value: 'a "q" $B' } })
		expect(read(`FOO="a b"'c'd`)).toEqual({ ok: { name: 'FOO', value: 'a bcd' } })
	})

	it('replaces $NAME and ${NAME} with a known value, and by nothing when unknown', () => {
		const names = { PATH: '/usr/bin' }
		expect(read('export PATH="/opt/tool/bin:$PATH"', names)).toEqual({
			ok: { name: 'PATH', value: '/opt/tool/bin:/usr/bin' },
		})
		expect(read('A=${PATH}/x', names)).toEqual({ ok: { name: 'A', value: '/usr/bin/x' } })
		expect(read('A=$NOPE', names)).toEqual({ ok: { name: 'A', value: '' } })
		expect(read('A=price$')).toEqual({ ok: { name: 'A', value: 'price$' } })
	})

	it('never reads a command substitution, in any form', () => {
		for (const line of [
			'A=$(whoami)',
			'A=`whoami`',
			'A="$(whoami)"',
			'A="`whoami`"',
			'A=$((1+1))',
			'A=${B:-x}',
			'A=${B',
		]) {
			expect(read(line), line).toHaveProperty('problem')
		}
	})

	it('does not read shell punctuation outside quotes, nor a second word', () => {
		for (const line of [
			'A=x;y',
			'A=x&&y',
			'A=x|y',
			'A=x>y',
			'A=a b',
			'A="unclosed',
			"A='unclosed",
		]) {
			expect(read(line), line).toHaveProperty('problem')
		}
		expect(read('A=x # why')).toEqual({ ok: { name: 'A', value: 'x' } })
	})

	it('does not read what is not a variable', () => {
		expect(read('1A=x')).toHaveProperty('problem')
		expect(read('A-B=x')).toHaveProperty('problem')
		expect(read('=x')).toHaveProperty('problem')
		expect(read('just words')).toHaveProperty('problem')
	})

	it('leaves out a value that is too long', () => {
		expect(read(`A=${'x'.repeat(MAX_HOOK_ENV_VALUE_CHARS + 1)}`)).toHaveProperty('problem')
		expect(read(`A=${'x'.repeat(MAX_HOOK_ENV_VALUE_CHARS)}`)).toHaveProperty('ok')
	})
})

describe('which names are refused', () => {
	it('allows PATH and ordinary names', () => {
		for (const name of ['PATH', 'JAVA_HOME', 'AWS_PROFILE', 'FOO']) {
			expect(refusedHookEnvName(name)).toBeUndefined()
		}
	})

	it('refuses the kernel settings, the loader, shell start-up and state locations, saying why', () => {
		for (const name of [
			'NAMZU_HOME',
			'NAMZU_ENV_FILE',
			'LD_PRELOAD',
			'LD_LIBRARY_PATH',
			'DYLD_INSERT_LIBRARIES',
			'BASH_ENV',
			'ENV',
			'PROMPT_COMMAND',
			'BASH_FUNC_x%%',
			'NODE_OPTIONS',
			'HOME',
			'XDG_CONFIG_HOME',
		]) {
			expect(refusedHookEnvName(name), name).toMatch(/\S+ .+/)
		}
		expect(read('export LD_PRELOAD=/tmp/x.so')).toHaveProperty('problem')
	})
})

describe('the session environment', () => {
	const dirs: string[] = []
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})
	const make = (inherited: NodeJS.ProcessEnv = {}) => {
		const directory = mkdtempSync(join(tmpdir(), 'namzu-hook-env-test-'))
		dirs.push(directory)
		const problems: string[] = []
		const env = new SessionHookEnv({
			directory: () => directory,
			inherited: () => inherited,
			onProblem: (message) => problems.push(message),
		})
		return { env, problems, directory }
	}

	it('makes no file until a hook asks, and gives an owner-only file when it does', () => {
		const { env, directory } = make()
		expect(existsSync(join(directory, 'session_start.env'))).toBe(false)
		const file = env.fileFor('session_start') as string
		expect(file).toBe(join(directory, 'session_start.env'))
		expect(statSync(file).mode & 0o077).toBe(0)
	})

	it('reads what a hook appended into one live object', () => {
		const { env } = make()
		const live = env.variables
		appendFileSync(env.fileFor('session_start') as string, 'export A=1\nB=two\n')
		env.absorb('session_start')
		expect(live).toEqual({ A: '1', B: 'two' })
		expect(env.variables).toBe(live)
	})

	it('lets a later line for a name replace an earlier one', () => {
		const { env } = make()
		appendFileSync(env.fileFor('session_start') as string, 'A=1\nA=2\n')
		env.absorb('session_start')
		expect(env.variables.A).toBe('2')
	})

	it('has no unset: an empty value is how a variable is emptied', () => {
		const { env } = make()
		const file = env.fileFor('session_start') as string
		appendFileSync(file, 'A=1\n')
		env.absorb('session_start')
		appendFileSync(file, 'A=\n')
		env.absorb('session_start')
		expect(env.variables.A).toBe('')
	})

	it('ranks session_start below cwd_changed below file_changed', () => {
		const { env } = make()
		appendFileSync(env.fileFor('file_changed') as string, 'A=file\n')
		appendFileSync(env.fileFor('session_start') as string, 'A=start\nB=start\n')
		appendFileSync(env.fileFor('cwd_changed') as string, 'A=cwd\nC=cwd\n')
		for (const event of ['session_start', 'cwd_changed', 'file_changed'] as const) env.absorb(event)
		expect(env.variables).toEqual({ A: 'file', B: 'start', C: 'cwd' })
		expect(env.describe()).toEqual([
			{ name: 'A', event: 'file_changed' },
			{ name: 'B', event: 'session_start' },
			{ name: 'C', event: 'cwd_changed' },
		])
	})

	it('clears what cwd_changed and file_changed set on a change of folder, and keeps session_start', () => {
		const { env } = make()
		appendFileSync(env.fileFor('session_start') as string, 'KEEP=1\n')
		appendFileSync(env.fileFor('cwd_changed') as string, 'OLD=1\n')
		appendFileSync(env.fileFor('file_changed') as string, 'OLDER=1\n')
		for (const event of ['session_start', 'cwd_changed', 'file_changed'] as const) env.absorb(event)
		env.clearFolderLayers()
		expect(env.variables).toEqual({ KEEP: '1' })
		expect(readFileSync(env.fileFor('cwd_changed') as string, 'utf8')).toBe('')
		appendFileSync(env.fileFor('cwd_changed') as string, 'NEW=1\n')
		env.absorb('cwd_changed')
		expect(env.variables).toEqual({ KEEP: '1', NEW: '1' })
	})

	it('reads $NAME from the inherited environment and from an earlier kind of hook', () => {
		const { env } = make({ PATH: '/usr/bin' })
		appendFileSync(env.fileFor('session_start') as string, 'export PATH="/a:$PATH"\nTOOLS=/t\n')
		appendFileSync(env.fileFor('cwd_changed') as string, 'export PATH="/b:$PATH"\nX=$TOOLS/x\n')
		env.absorb('session_start')
		env.absorb('cwd_changed')
		expect(env.variables.PATH).toBe('/b:/a:/usr/bin')
		expect(env.variables.X).toBe('/t/x')
		// Reading again changes nothing.
		env.absorb('cwd_changed')
		expect(env.variables.PATH).toBe('/b:/a:/usr/bin')
	})

	it('reports a refused name and an unreadable line once each, and sets neither', () => {
		const { env, problems } = make()
		const file = env.fileFor('session_start') as string
		appendFileSync(file, 'export LD_PRELOAD=/x.so\nA=$(id)\nOK=1\n')
		env.absorb('session_start')
		env.absorb('session_start')
		expect(env.variables).toEqual({ OK: '1' })
		expect(problems).toHaveLength(2)
		expect(problems[0]).toMatch(/LD_PRELOAD.*dynamic loader/)
		expect(problems[1]).toMatch(/command substitution/)
	})

	it('reads only the first 64 KiB of a file, and says so', () => {
		const { env, problems } = make()
		const file = env.fileFor('session_start') as string
		appendFileSync(file, `FIRST=1\n${'# pad\n'.repeat(MAX_HOOK_ENV_FILE_BYTES / 5)}LAST=1\n`)
		env.absorb('session_start')
		expect(env.variables).toEqual({ FIRST: '1' })
		expect(problems.join(' ')).toMatch(/only the first 64 KiB/)
	})

	it('keeps at most 128 variables', () => {
		const { env, problems } = make()
		const lines = Array.from({ length: MAX_HOOK_ENV_VARIABLES + 5 }, (_, i) => `V${i}=1`).join('\n')
		appendFileSync(env.fileFor('session_start') as string, `${lines}\n`)
		env.absorb('session_start')
		expect(Object.keys(env.variables)).toHaveLength(MAX_HOOK_ENV_VARIABLES)
		expect(problems.join(' ')).toMatch(/more than 128/)
	})

	it('treats __proto__ as a name like any other', () => {
		const { env } = make()
		appendFileSync(env.fileFor('session_start') as string, '__proto__=x\n')
		env.absorb('session_start')
		expect(Object.keys(env.variables)).toEqual(['__proto__'])
		expect(({} as Record<string, unknown>).x).toBeUndefined()
	})

	it('removes its files and empties the object when disposed', () => {
		const { env, directory } = make()
		appendFileSync(env.fileFor('session_start') as string, 'A=1\n')
		env.absorb('session_start')
		env.dispose()
		expect(existsSync(directory)).toBe(false)
		expect(Object.keys(env.variables)).toEqual([])
		expect(env.fileFor('session_start')).toBeUndefined()
	})
})

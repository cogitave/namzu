import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { describeHooksStatus } from '../doctor/checks/hooks.js'
import { readFolderGrants } from '../integrations/trust/folder-grants.js'
import { renderHooks } from '../tui/slashCommands.js'
import { hookIdentity } from './hook-layers.js'
import {
	type HookConfigProblem,
	hookConfigProblems,
	loadConfig,
	resetHookConfigProblems,
	takeConfigWarnings,
} from './load.js'

const dirs: string[] = []
function project(hooks: unknown) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-env-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-env-cwd-'))
	dirs.push(home, cwd)
	writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ hooks }))
	return { home, cwd, env: {} }
}
const load = (hooks: unknown) => loadConfig(project(hooks))

beforeEach(() => {
	resetHookConfigProblems()
	takeConfigWarnings()
})
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const notes = (): string[] =>
	hookConfigProblems().map((problem: HookConfigProblem) => problem.message)

describe('the env key of a command entry', () => {
	it('is read in our own shape', () => {
		const hooks = load({
			pre_tool_use: [{ command: 'a.sh', env: { A: 'x', B: '${NAMZU_PROJECT_DIR}' } }],
		}).hooks
		expect(hooks?.pre_tool_use?.[0]).toMatchObject({ env: { A: 'x', B: '${NAMZU_PROJECT_DIR}' } })
	})

	it('is read in the common shape, and the hook is read as written', () => {
		const hooks = load({
			PreToolUse: [
				{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh', env: { A: 'x' } }] },
			],
		}).hooks
		expect(hooks?.pre_tool_use?.[0]).toMatchObject({ command: 'a.sh', env: { A: 'x' } })
		expect(notes().filter((m) => m.includes('env'))).toEqual([])
	})

	it('refuses a bad name or a value that is not text in our own shape', () => {
		expect(() => load({ pre_tool_use: [{ command: 'a', env: { 'A-B': 'x' } }] })).toThrow(/env/)
		expect(() => load({ pre_tool_use: [{ command: 'a', env: { A: 1 } }] })).toThrow(/must be text/)
		expect(() => load({ pre_tool_use: [{ command: 'a', env: ['A'] }] })).toThrow(/mapping/)
		expect(() =>
			load({ pre_tool_use: [{ command: 'a', env: { NAMZU_HOOK_EVENT: 'x' } }] }),
		).toThrow(/cannot be replaced/)
	})

	it('in the common shape leaves a bad name off with a note and still loads the hook', () => {
		const hooks = load({
			PreToolUse: [{ hooks: [{ command: 'a.sh', env: { 'A-B': 'x', OK: 'y', N: 3 } }] }],
		}).hooks
		expect(hooks?.pre_tool_use?.[0]).toMatchObject({ command: 'a.sh', env: { OK: 'y' } })
		const said = notes().join('\n')
		expect(said).toContain('"A-B"')
		expect(said).toContain('"N" must be text')
	})

	it('in the common shape drops an env that is not a mapping, and the hook still runs', () => {
		const hooks = load({ PreToolUse: [{ hooks: [{ command: 'a.sh', env: 'A=1' }] }] }).hooks
		expect(hooks?.pre_tool_use).toHaveLength(1)
		expect(hooks?.pre_tool_use?.[0]).not.toHaveProperty('env')
		expect(notes().join('\n')).toContain('"env" must be a mapping')
	})

	it('is not a setting of an http hook', () => {
		expect(() =>
			load({ pre_tool_use: [{ type: 'http', url: 'http://127.0.0.1:1/x', env: { A: 'x' } }] }),
		).toThrow(/not a setting of a http hook/)
	})
})

describe('the run-once identity', () => {
	it('differs by env, and not by the order the names were written in', () => {
		const a = hookIdentity('pre_tool_use', { command: 'x', env: { A: '1', B: '2' } })
		const b = hookIdentity('pre_tool_use', { command: 'x', env: { B: '2', A: '1' } })
		const c = hookIdentity('pre_tool_use', { command: 'x', env: { A: '1', B: '3' } })
		const none = hookIdentity('pre_tool_use', { command: 'x' })
		expect(a).toBe(b)
		expect(a).not.toBe(c)
		expect(a).not.toBe(none)
	})

	it('is unchanged for an entry with no env', () => {
		expect(hookIdentity('pre_tool_use', { command: 'x' })).toBe(
			JSON.stringify(['pre_tool_use', { command: 'x', type: 'command' }]),
		)
	})
})

describe('what shows an env', () => {
	it('/hooks lists the names, never the values', () => {
		const text = renderHooks({ pre_tool_use: [{ command: 'a.sh', env: { A: 'secret', B: 'x' } }] })
		expect(text).toContain('sets A, B')
		expect(text).not.toContain('secret')
	})

	it('/hooks says nothing extra for an entry without one', () => {
		expect(renderHooks({ pre_tool_use: [{ command: 'a.sh' }] })).not.toContain('sets')
	})

	it('the folder trust screen shows the names an entry sets beside its command', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-env-trust-'))
		dirs.push(root)
		writeFileSync(
			join(root, 'namzu.config.json'),
			JSON.stringify({
				hooks: { pre_tool_use: [{ command: './a.sh', env: { PATH: '/evil', X: 'y' } }] },
			}),
		)
		expect(readFolderGrants(root).hooks).toEqual([
			{ event: 'pre_tool_use', runs: './a.sh (sets PATH, X)' },
		])
	})
})

describe('the doctor row and a variable that is set nowhere', () => {
	const sourced = (entry: Record<string, unknown>) => ({
		hooks: { pre_tool_use: [{ ...entry, source: '~/.namzu/config.yaml' }] },
	})

	it('names the variable and the env key', () => {
		const result = describeHooksStatus(
			sourced({ command: '"$ZZ_UNSET_TOOL_HOME/run.sh"' }) as never,
		)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('$ZZ_UNSET_TOOL_HOME')
		expect(result.message).toContain('"env" key')
	})

	it('says nothing for a name ending in _PROJECT_DIR, one env gives, a default, or one the command sets', () => {
		for (const entry of [
			{ command: '"$ANYTOOL_PROJECT_DIR/x"' },
			{ command: '"$ZZ_UNSET_A/x"', env: { ZZ_UNSET_A: '/a' } },
			{ command: '"${ZZ_UNSET_B:-/b}/x"' },
			{ command: 'ZZ_UNSET_C=/c; "$ZZ_UNSET_C/x"' },
			{ command: '"$NAMZU_PROJECT_DIR/x"' },
		]) {
			expect(describeHooksStatus(sourced(entry) as never).status).toBe('pass')
		}
	})
})

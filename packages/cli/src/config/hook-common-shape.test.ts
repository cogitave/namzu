import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import {
	hookConfigProblems,
	loadConfig,
	resetHookConfigProblems,
	takeConfigWarnings,
} from './load.js'

function project(hooks: unknown, user?: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-common-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-common-cwd-'))
	writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ hooks }))
	return { home, cwd, env: {} }
}

// `source` (the file an entry came from) is not what these tests are about.
const load = (hooks: unknown, user?: string) => {
	const config = loadConfig(project(hooks, user))
	return {
		...config,
		hooks: Object.fromEntries(
			Object.entries(config.hooks ?? {}).map(([event, entries]) => [
				event,
				(entries ?? []).map(({ source: _source, ...rest }: { source?: string }) => rest),
			]),
		) as Record<string, Record<string, unknown>[]>,
	}
}

beforeEach(() => {
	resetHookConfigProblems()
	takeConfigWarnings()
})

const commonBlock = {
	PreToolUse: [
		{
			matcher: 'Bash',
			hooks: [{ type: 'command', command: './guard.sh', timeout: 5, if: 'Bash(git push *)' }],
		},
	],
	PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: './fmt.sh' }] }],
	Stop: [{ hooks: [{ type: 'command', command: './stop.sh', once: true, statusMessage: 'bye' }] }],
	SessionStart: [{ hooks: [{ type: 'command', command: './start.sh', async: true }] }],
}

describe('a hooks block in the common shape', () => {
	it('is read as written: each group becomes entries of our event, seconds become milliseconds', () => {
		const hooks = load(commonBlock).hooks
		expect(hooks?.pre_tool_use).toEqual([
			expect.objectContaining({
				command: './guard.sh',
				matcher: 'Bash',
				timeoutMs: 5000,
				if: 'Bash(git push *)',
				toolNames: 'written',
			}),
		])
		expect(hooks?.post_tool_use?.[0]).toMatchObject({ matcher: 'Edit|Write', toolNames: 'written' })
		expect(hooks?.turn_end?.[0]).toMatchObject({
			command: './stop.sh',
			once: true,
			statusMessage: 'bye',
		})
		expect(hooks?.session_start?.[0]).toMatchObject({ command: './start.sh', async: true })
		expect(hookConfigProblems()).toEqual([])
	})

	it('reads http and prompt hooks, the group matcher on each hook of the group', () => {
		const hooks = load({
			PreToolUse: [
				{
					matcher: 'Bash',
					hooks: [
						{
							type: 'http',
							url: 'http://127.0.0.1:9/h',
							headers: { A: 'b' },
							allowedEnvVars: ['X'],
							timeout: 2.5,
						},
						{ type: 'prompt', prompt: 'is it safe?' },
						{ command: 'c.sh' },
					],
				},
			],
		}).hooks
		expect(hooks?.pre_tool_use).toEqual([
			{
				type: 'http',
				url: 'http://127.0.0.1:9/h',
				headers: { A: 'b' },
				allowedEnvVars: ['X'],
				matcher: 'Bash',
				timeoutMs: 2500,
				toolNames: 'written',
			},
			{ type: 'prompt', prompt: 'is it safe?', matcher: 'Bash', toolNames: 'written' },
			{ command: 'c.sh', matcher: 'Bash', toolNames: 'written' },
		])
	})

	it('may be mixed with our own shape in one file, and both spellings of an event join', () => {
		const hooks = load({
			PreToolUse: [{ hooks: [{ command: 'common.sh' }] }],
			pre_tool_use: [{ command: 'own.sh' }],
		}).hooks
		expect((hooks.pre_tool_use ?? []).map((e) => e.command)).toEqual(['common.sh', 'own.sh'])
		expect(hooks?.pre_tool_use?.[1]).not.toHaveProperty('toolNames')
	})

	it('reads our own entries under a PascalCase key, and groups under our own key', () => {
		const hooks = load({
			Stop: [{ command: 'own.sh' }],
			turn_end: [{ hooks: [{ command: 'grp.sh' }] }],
		}).hooks
		expect(hooks?.turn_end).toEqual([
			{ command: 'own.sh' },
			{ command: 'grp.sh', toolNames: 'written' },
		])
	})

	it('combines with the user file, and an identical entry runs once across the shapes', () => {
		const config = load(
			{ PreToolUse: [{ matcher: 'bash', hooks: [{ command: 'g.sh', toolNames: 'ignored' }] }] },
			'hooks:\n  pre_tool_use:\n    - matcher: bash\n      command: g.sh\n      toolNames: written\n',
		)
		// The extra key on the common hook is not acted on, so the two entries are
		// the same: one runs.
		expect(config.hooks?.pre_tool_use).toHaveLength(1)
	})
})

describe('nothing is dropped in silence', () => {
	it('says an event with no counterpart, loads the rest, and counts it a problem', () => {
		const config = load({
			TeammateIdle: [{ hooks: [{ command: 'x.sh' }] }],
			Stop: [{ hooks: [{ command: 'ok.sh' }] }],
		})
		expect(config.hooks?.turn_end).toHaveLength(1)
		const problems = hookConfigProblems()
		expect(problems).toHaveLength(1)
		expect(problems[0]).toMatchObject({ event: 'TeammateIdle', severity: 'problem' })
		expect(problems[0]?.file).toContain('namzu.config.json')
		expect(problems[0]?.message).toContain('none of its hooks will run')
		expect(takeConfigWarnings().join('\n')).toContain('Hook problem in')
	})

	it('says a kind this kernel does not have: a problem on a tool event, a note elsewhere', () => {
		const config = load({
			PreToolUse: [{ hooks: [{ type: 'agent', prompt: 'p' }, { command: 'kept.sh' }] }],
			SessionStart: [{ hooks: [{ type: 'mcp_tool', server: 's' }] }],
		})
		expect(config.hooks.pre_tool_use).toHaveLength(1)
		const [guard, other] = hookConfigProblems()
		expect(guard).toMatchObject({ event: 'PreToolUse', severity: 'problem' })
		expect(guard?.message).toContain('"agent"')
		expect(guard?.message).toContain('what it was meant to guard is not checked')
		expect(other).toMatchObject({ event: 'SessionStart', severity: 'note' })
	})

	it('says a key it does not act on, and still loads the hook', () => {
		const config = load({
			PreToolUse: [{ hooks: [{ command: 'x.sh', shell: 'bash', asyncRewake: true }], note: 'hi' }],
		})
		expect(config.hooks?.pre_tool_use).toHaveLength(1)
		const messages = hookConfigProblems().map((p) => p.message)
		expect(messages.some((m) => m.includes('"shell" is not acted on'))).toBe(true)
		expect(messages.some((m) => m.includes('"asyncRewake" is not acted on'))).toBe(true)
		expect(messages.some((m) => m.includes('"note" is not a setting of a group'))).toBe(true)
		expect(hookConfigProblems().every((p) => p.severity === 'note')).toBe(true)
	})

	it('errs towards running when a setting cannot be read: it is left off and said', () => {
		const config = load({
			PreToolUse: [
				{
					matcher: ['Bash'],
					hooks: [{ command: 'x.sh', timeout: 'soon', if: 3, once: 'yes', onFailure: 'maybe' }],
				},
			],
		})
		const entry = config.hooks?.pre_tool_use?.[0]
		expect(entry).toEqual({ command: 'x.sh', toolNames: 'written' })
		expect(hookConfigProblems()).toHaveLength(5)
	})

	it('reports a hook that cannot be loaded and keeps its neighbours', () => {
		const config = load({
			PreToolUse: [
				{
					hooks: [
						{ type: 'command' },
						'text',
						{ type: 'http', url: 'ftp://x' },
						{ type: 'prompt' },
						{ command: 'x', args: [1] },
						{ command: 'good.sh' },
					],
				},
				{ matcher: 'Bash' },
			],
		})
		expect(config.hooks?.pre_tool_use).toEqual([{ command: 'good.sh', toolNames: 'written' }])
		const problems = hookConfigProblems()
		expect(problems.filter((p) => p.severity === 'problem')).toHaveLength(6)
	})

	it('still refuses what it always refused: a misspelt event of our own shape, a renamed event, a bad entry of ours', () => {
		expect(() => load({ on_save: [{ command: 'x' }] })).toThrow(/is not a hook event/)
		expect(() => load({ run_end: [{ command: 'x' }] })).toThrow(/was renamed/)
		expect(() => load({ turn_end: [{ command: 'x', shell: 'zsh' }] })).toThrow(
			/turn_end\[0\]\.shell/,
		)
		expect(() => load({ turn_end: [{ command: 'x', toolNames: 'both' }] })).toThrow(/toolNames/)
	})
})

describe('an element that is not a mapping under a PascalCase event', () => {
	it('is said out loud and the rest of the file loads', () => {
		const config = load({
			PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'a.sh' }] }, 'garbage', 7],
			Stop: [null, { hooks: [{ command: 'stop.sh' }] }],
			SessionStart: ['x'],
		})
		expect(config.hooks.pre_tool_use).toEqual([
			{ command: 'a.sh', matcher: 'Bash', toolNames: 'written' },
		])
		expect(config.hooks.turn_end).toHaveLength(1)
		const problems = hookConfigProblems()
		expect(problems.filter((p) => p.severity === 'problem')).toHaveLength(3)
		expect(problems.filter((p) => p.severity === 'note')).toHaveLength(1)
		expect(problems.every((p) => /is not a mapping/.test(p.message))).toBe(true)
	})

	it('a list under our own spelling still refuses one', () => {
		expect(() => load({ pre_tool_use: ['garbage'] })).toThrow(/must be a mapping/)
	})
})

describe('toolNames on an entry of our own shape', () => {
	it('is read, and absent means our names', () => {
		const hooks = load({
			pre_tool_use: [
				{ command: 'a.sh', toolNames: 'written' },
				{ command: 'b.sh', toolNames: 'namzu' },
				{ command: 'c.sh' },
			],
		}).hooks
		expect(hooks.pre_tool_use?.map((e) => e.toolNames)).toEqual(['written', 'namzu', undefined])
	})
})

describe('the worktree events', () => {
	it('are read in both shapes, by either spelling', () => {
		const config = load({
			WorktreeCreate: [{ hooks: [{ type: 'command', command: 'make.sh' }] }],
			worktree_remove: [{ command: 'rm.sh' }],
		})
		expect(config.hooks.worktree_create?.map((entry) => entry.command)).toEqual(['make.sh'])
		expect(config.hooks.worktree_remove?.map((entry) => entry.command)).toEqual(['rm.sh'])
		expect(hookConfigProblems()).toEqual([])
	})

	it('keep a matcher as written; the hook ignores it at run time', () => {
		const config = load({ WorktreeCreate: [{ matcher: 'anything', hooks: [{ command: 'x' }] }] })
		expect(config.hooks.worktree_create?.[0]?.matcher).toBe('anything')
	})
})

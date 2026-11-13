/**
 * `file_changed` and `cwd_changed` as shell hooks: what they are sent, how a
 * matcher reads a file, what they may answer (a line for the person and a new
 * list of paths, never a refusal and never context), and the variables file.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginHookContext, PluginHookResult } from '../../types/plugin/index.js'
import { asSessionId } from '../../utils/id.js'
import { FileChangeHooks, watchPathsOf } from '../file-change-hooks.js'
import { SessionHookEnv } from '../session-hook-env.js'
import {
	SHELL_HOOK_EVENTS,
	SHELL_HOOK_PASCAL_EVENT_NAMES,
	createShellHook,
	fileChangedMatcherNote,
	fileChangedMatcherPaths,
	fileChangedMatches,
	shellHookPayload,
	shellHookVerdict,
} from '../shell-hook.js'

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'
const ok = { exitCode: 0, timedOut: false, stdout: '', stderr: '' }
const json = (value: unknown) => ({ ...ok, stdout: JSON.stringify(value) })
const entry = { command: 'x' }

describe('the events', () => {
	it('are shell hook events with their written names', () => {
		expect(SHELL_HOOK_EVENTS).toContain('file_changed')
		expect(SHELL_HOOK_EVENTS).toContain('cwd_changed')
		expect(SHELL_HOOK_PASCAL_EVENT_NAMES.file_changed).toBe('FileChanged')
		expect(SHELL_HOOK_PASCAL_EVENT_NAMES.cwd_changed).toBe('CwdChanged')
	})

	it('send the file and what happened, and the old and the new folder', () => {
		const file = JSON.parse(
			shellHookPayload({
				event: 'file_changed',
				cwd: '/p',
				sessionId: SESSION,
				filePath: '/p/.envrc',
				change: 'add',
			}),
		)
		expect(file).toMatchObject({
			event: 'file_changed',
			hook_event_name: 'FileChanged',
			file_path: '/p/.envrc',
			change: 'add',
		})
		expect(file.turn_id).toBeUndefined()
		const folder = JSON.parse(
			shellHookPayload({
				event: 'cwd_changed',
				cwd: '/p/sub',
				sessionId: SESSION,
				oldCwd: '/p',
				newCwd: '/p/sub',
			}),
		)
		expect(folder).toMatchObject({
			hook_event_name: 'CwdChanged',
			old_cwd: '/p',
			new_cwd: '/p/sub',
		})
	})
})

describe('the matcher of file_changed', () => {
	it('names the files to watch: the plain parts of a list', () => {
		expect(fileChangedMatcherPaths('.envrc|config/app.json')).toEqual(['.envrc', 'config/app.json'])
		expect(fileChangedMatcherPaths('.envrc,/etc/hosts')).toEqual(['.envrc', '/etc/hosts'])
		expect(fileChangedMatcherPaths('.env.*|.envrc')).toEqual(['.envrc'])
		expect(fileChangedMatcherPaths(undefined)).toEqual([])
		expect(fileChangedMatcherPaths('*')).toEqual([])
		expect(fileChangedMatcherPaths('^\\.env(rc)?$')).toEqual([])
	})

	it('says when a matcher names no file', () => {
		expect(fileChangedMatcherNote(undefined)).toMatch(/watches nothing itself/)
		expect(fileChangedMatcherNote('.envrc')).toBeUndefined()
	})

	it('is tested against the base name, and a path stands for its base name', () => {
		expect(fileChangedMatches('.envrc', '/p/.envrc')).toBe(true)
		expect(fileChangedMatches('.envrc', '/p/sub/.envrc')).toBe(true)
		expect(fileChangedMatches('config/app.json', '/p/config/app.json')).toBe(true)
		expect(fileChangedMatches('.envrc|package.json', '/p/package.json')).toBe(true)
		expect(fileChangedMatches('.envrc', '/p/other')).toBe(false)
		expect(fileChangedMatches('.env.*', '/p/.env.local')).toBe(true)
		expect(fileChangedMatches('*', '/p/anything')).toBe(true)
		expect(fileChangedMatches(undefined, '/p/anything')).toBe(true)
	})

	it('reads a pattern as a pattern, and an unreadable one fires', () => {
		expect(fileChangedMatches('^\\.env', '/p/.envrc')).toBe(true)
		expect(fileChangedMatches('^\\.env', '/p/other')).toBe(false)
		expect(fileChangedMatches('([', '/p/any')).toBe(true)
	})

	it('fires when the event names no file', () => {
		expect(fileChangedMatches('.envrc', undefined)).toBe(true)
	})
})

describe('what these hooks may answer', () => {
	for (const event of ['file_changed', 'cwd_changed'] as const) {
		const name = SHELL_HOOK_PASCAL_EVENT_NAMES[event]
		it(`${event}: a line for the person and the next list of paths`, () => {
			expect(
				shellHookVerdict(
					event,
					entry,
					json({
						systemMessage: 'reloaded',
						hookSpecificOutput: { hookEventName: name, watchPaths: ['a', '/b/c'] },
					}),
				),
			).toEqual({ action: 'continue', notice: 'reloaded', watchPaths: ['a', '/b/c'] })
		})

		it(`${event}: cannot refuse, and adds nothing for the model`, () => {
			for (const answer of [
				{ exitCode: 2, timedOut: false, stdout: '', stderr: 'no' },
				json({ decision: 'block', reason: 'no' }),
				json({ hookSpecificOutput: { hookEventName: name, additionalContext: 'for the model' } }),
				{ ...ok, stdout: 'plain words' },
			]) {
				expect(shellHookVerdict(event, entry, answer)).toEqual({ action: 'continue' })
			}
		})

		it(`${event}: an empty list is a list`, () => {
			expect(
				shellHookVerdict(
					event,
					entry,
					json({ hookSpecificOutput: { hookEventName: name, watchPaths: [] } }),
				),
			).toEqual({ action: 'continue', watchPaths: [] })
		})

		it(`${event}: a list that is not a list of paths is reported, not half-read`, () => {
			for (const bad of ['a', [1], { a: 1 }]) {
				const verdict = shellHookVerdict(
					event,
					{ ...entry, onFailure: 'block' },
					json({ hookSpecificOutput: { hookEventName: name, watchPaths: bad } }),
				)
				// Nothing here can be refused, so a failed read is still `continue`.
				expect(verdict).toEqual({ action: 'continue' })
			}
		})

		it(`${event}: a list written at the top level is set aside as unreadable`, () => {
			expect(shellHookVerdict(event, entry, json({ watchPaths: ['a'] }))).toEqual({
				action: 'continue',
			})
		})
	}

	it('session_start can hand a list too, with or without context', () => {
		const specific = { hookEventName: 'SessionStart', watchPaths: ['.envrc'] }
		expect(
			shellHookVerdict('session_start', entry, json({ hookSpecificOutput: specific })),
		).toEqual({
			action: 'continue',
			watchPaths: ['.envrc'],
		})
		expect(
			shellHookVerdict(
				'session_start',
				entry,
				json({
					systemMessage: 'hi',
					hookSpecificOutput: { ...specific, additionalContext: 'ctx' },
				}),
			),
		).toEqual({ action: 'annotate', text: 'ctx', watchPaths: ['.envrc'], notice: 'hi' })
	})

	it('other events ignore a list', () => {
		expect(
			shellHookVerdict(
				'turn_end',
				entry,
				json({ hookSpecificOutput: { hookEventName: 'Stop', watchPaths: ['a'] } }),
			),
		).toEqual({ action: 'continue' })
	})
})

describe('watchPathsOf', () => {
	it('is the union of what the answers hand back, and undefined when none did', () => {
		const answers: PluginHookResult[] = [
			{ action: 'continue', watchPaths: ['a', 'b'] },
			{ action: 'continue' },
			{ action: 'annotate', text: 't', watchPaths: ['b', 'c'] },
		]
		expect(watchPathsOf(answers)).toEqual(['a', 'b', 'c'])
		expect(watchPathsOf([{ action: 'continue' }])).toBeUndefined()
		expect(watchPathsOf([{ action: 'continue', watchPaths: [] }])).toEqual([])
	})
})

describe('NAMZU_ENV_FILE', () => {
	const dirs: string[] = []
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})
	const context = (event: PluginHookContext['event'], extra: Partial<PluginHookContext> = {}) =>
		({
			event,
			sessionId: asSessionId(SESSION),
			pluginId: 'p',
			...extra,
		}) as unknown as PluginHookContext

	const run = async (
		event: 'session_start' | 'cwd_changed' | 'file_changed' | 'turn_start',
		script: string,
	) => {
		const directory = mkdtempSync(join(tmpdir(), 'namzu-hook-env-run-'))
		dirs.push(directory)
		const hookEnv = new SessionHookEnv({ directory: () => directory, inherited: () => ({}) })
		const hook = createShellHook(event, { command: script }, { cwd: directory, hookEnv })
		const answer = await hook.handler(
			context(event, { filePath: join(directory, 'f'), change: 'change' }),
		)
		return { hookEnv, answer }
	}

	it('is given to a session_start, cwd_changed and file_changed command, whose lines are then in effect', async () => {
		for (const event of ['session_start', 'cwd_changed', 'file_changed'] as const) {
			const { hookEnv } = await run(
				event,
				`printf 'export SEEN_${event}=1\\n' >> "$NAMZU_ENV_FILE"`,
			)
			expect(hookEnv.variables, event).toEqual({ [`SEEN_${event}`]: '1' })
		}
	})

	it('is not given on any other event, nor inherited from an enclosing hook', async () => {
		process.env.NAMZU_ENV_FILE = '/nonexistent/inherited'
		try {
			const { answer } = await run('turn_start', 'test -z "$NAMZU_ENV_FILE"')
			expect(answer).toEqual({ action: 'continue' })
			const { hookEnv } = await run('turn_start', 'echo X=1 >> "${NAMZU_ENV_FILE:-/dev/null}"')
			expect(hookEnv.variables).toEqual({})
		} finally {
			process.env.NAMZU_ENV_FILE = undefined
			// biome-ignore lint/performance/noDelete: an assigned undefined would be the text "undefined"
			delete process.env.NAMZU_ENV_FILE
		}
	})

	it('does not change the hook’s own environment: it sees none of what it set', async () => {
		const { hookEnv } = await run(
			'session_start',
			`echo 'A=1' >> "$NAMZU_ENV_FILE"; test -z "$A" && echo 'B=ok' >> "$NAMZU_ENV_FILE"`,
		)
		expect(hookEnv.variables).toEqual({ A: '1', B: 'ok' })
	})

	it('keeps what a hook wrote before it failed', async () => {
		const { hookEnv } = await run('session_start', `echo 'A=1' >> "$NAMZU_ENV_FILE"; exit 7`)
		expect(hookEnv.variables).toEqual({ A: '1' })
	})

	it('never runs a command a line holds', async () => {
		const marker = join(tmpdir(), `namzu-never-${process.pid}`)
		const { hookEnv } = await run(
			'session_start',
			`echo 'A=$(touch ${marker})' >> "$NAMZU_ENV_FILE"; echo 'B=\`touch ${marker}\`' >> "$NAMZU_ENV_FILE"`,
		)
		expect(hookEnv.variables).toEqual({})
		expect(await import('node:fs').then((fs) => fs.existsSync(marker))).toBe(false)
	})

	it('does nothing without a hookEnv: no variable, and the hook still runs', async () => {
		const hook = createShellHook(
			'session_start',
			{ command: 'test -z "$NAMZU_ENV_FILE" && echo fine' },
			{ cwd: tmpdir() },
		)
		expect(await hook.handler(context('session_start'))).toEqual({
			action: 'annotate',
			text: 'fine',
		})
	})
})

describe('a file_changed hook through createShellHook', () => {
	const context = (extra: Partial<PluginHookContext>) =>
		({
			event: 'file_changed',
			sessionId: asSessionId(SESSION),
			pluginId: 'p',
			...extra,
		}) as unknown as PluginHookContext

	it('does not run for a file its matcher does not name, and runs for one it does', async () => {
		const hook = createShellHook(
			'file_changed',
			{ command: 'cat >/dev/null; echo "{\\"systemMessage\\":\\"ran\\"}"', matcher: '.envrc' },
			{ cwd: tmpdir() },
		)
		expect(await hook.handler(context({ filePath: '/p/other', change: 'change' }))).toEqual({
			action: 'continue',
		})
		expect(await hook.handler(context({ filePath: '/p/.envrc', change: 'change' }))).toEqual({
			action: 'continue',
			notice: 'ran',
		})
	})

	it('is sent the file and the change on stdin', async () => {
		const hook = createShellHook(
			'file_changed',
			{
				command: `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({systemMessage:j.hook_event_name+" "+j.file_path+" "+j.change}))})'`,
			},
			{ cwd: tmpdir() },
		)
		expect(await hook.handler(context({ filePath: '/p/a', change: 'unlink' }))).toEqual({
			action: 'continue',
			notice: 'FileChanged /p/a unlink',
		})
	}, 30_000)

	it('a cwd_changed hook runs in the folder entered', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'namzu-cwd-hook-'))
		try {
			const hook = createShellHook('cwd_changed', { command: 'pwd -P' }, { cwd: tmpdir() })
			const answer = await hook.handler({
				event: 'cwd_changed',
				sessionId: asSessionId(SESSION),
				pluginId: 'p',
				oldCwd: tmpdir(),
				newCwd: directory,
			} as unknown as PluginHookContext)
			// Plain output on cwd_changed is nobody's context: the hook ran, said nothing.
			expect(answer).toEqual({ action: 'continue' })
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

describe('FileChangeHooks', () => {
	const fake = () => {
		const calls: Array<{ event: string; context: Record<string, unknown> }> = []
		let answers: PluginHookResult[] = []
		return {
			calls,
			answer: (next: PluginHookResult[]) => {
				answers = next
			},
			manager: {
				executeHooks: vi.fn(async (event: string, context: Record<string, unknown>) => {
					calls.push({ event, context })
					return answers
				}),
			},
		}
	}
	const seams = () => {
		const listeners = new Map<string, (name: string | null) => void>()
		return {
			listeners,
			watcher: {
				settleMs: 0,
				exists: () => true,
				watchDirectory: (dir: string, listener: (name: string | null) => void) => {
					listeners.set(dir, listener)
					return { close: () => listeners.delete(dir) }
				},
			},
		}
	}

	it('watches nothing when no hook names a path', () => {
		const f = fake()
		const s = seams()
		const hooks = new FileChangeHooks({
			manager: f.manager as never,
			cwd: '/p',
			sessionId: () => SESSION,
			matcherPaths: [],
			watcher: s.watcher,
		})
		expect(hooks.watching).toEqual([])
		expect(s.listeners.size).toBe(0)
		hooks.close()
	})

	it('watches the matcher paths, and a list handed back replaces the earlier list but not them', () => {
		const f = fake()
		const s = seams()
		const hooks = new FileChangeHooks({
			manager: f.manager as never,
			cwd: '/p',
			sessionId: () => SESSION,
			matcherPaths: ['.envrc'],
			watcher: s.watcher,
		})
		expect(hooks.watching).toEqual(['/p/.envrc'])
		hooks.absorb([{ action: 'continue', watchPaths: ['a.txt', '/q/b.txt'] }])
		expect(hooks.watching).toEqual(['/p/.envrc', '/p/a.txt', '/q/b.txt'])
		hooks.absorb([{ action: 'continue', watchPaths: ['c.txt'] }])
		expect(hooks.watching).toEqual(['/p/.envrc', '/p/c.txt'])
		hooks.absorb([{ action: 'continue' }])
		expect(hooks.watching).toEqual(['/p/.envrc', '/p/c.txt'])
		hooks.absorb([{ action: 'continue', watchPaths: [] }])
		expect(hooks.watching).toEqual(['/p/.envrc'])
		hooks.close()
	})

	it('fires file_changed for a change and applies the answer', async () => {
		vi.useFakeTimers()
		try {
			const f = fake()
			const s = seams()
			const notices: string[] = []
			const hooks = new FileChangeHooks({
				manager: f.manager as never,
				cwd: '/p',
				sessionId: () => SESSION,
				matcherPaths: ['.envrc'],
				onNotice: (line) => notices.push(line),
				watcher: s.watcher,
			})
			f.answer([{ action: 'continue', notice: ' reloaded ', watchPaths: ['x'] }])
			;(s.listeners.get('/p') as (name: string) => void)('.envrc')
			await vi.advanceTimersByTimeAsync(10)
			expect(f.calls).toEqual([
				{
					event: 'file_changed',
					context: { sessionId: SESSION, filePath: '/p/.envrc', change: 'change' },
				},
			])
			expect(notices).toEqual(['reloaded'])
			expect(hooks.watching).toEqual(['/p/.envrc', '/p/x'])
			hooks.close()
		} finally {
			vi.useRealTimers()
		}
	})
})

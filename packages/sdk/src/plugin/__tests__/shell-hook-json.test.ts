/**
 * A shell hook answers with JSON on stdout as well as an exit code.
 *
 * Two layers, on purpose. The verdict mapper is pure, so every field of the
 * contract and every exit code is pinned per event without a process. A few
 * cases then run real `sh`, because what a script can actually print (a
 * quoted heredoc, a number where a string belongs) is a fact about processes.
 */

import { describe, expect, it, vi } from 'vitest'

import type { PluginHookContext, PluginHookDefinition } from '../../types/plugin/index.js'
import { asSessionId, asTurnId } from '../../utils/id.js'
import {
	SHELL_HOOKS_PLUGIN_ID,
	type ShellHookEvent,
	attachShellHooks,
	createShellHook,
	runShellHook,
	shellHookIfMatches,
	shellHookMatches,
	shellHookVerdict,
} from '../shell-hook.js'

const entry = { command: 'x' }
const ok = { exitCode: 0, timedOut: false, stdout: '', stderr: '' }
const out = (stdout: unknown) => ({
	...ok,
	stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
})
const exit2 = (stderr: string) => ({ ...ok, exitCode: 2, stderr })

function spyLog() {
	const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }
	return {
		log: log as unknown as Parameters<typeof shellHookVerdict>[3],
		...log,
	}
}

describe('exit code 2, read per event', () => {
	it.each(['pre_tool_use', 'user_prompt_submit'] as const)('refuses on %s', (event) => {
		expect(shellHookVerdict(event, entry, exit2('no\n'))).toEqual({
			action: 'skip',
			reason: 'no',
		})
	})

	it.each(['turn_end', 'subagent_stop'] as const)(
		'on %s feeds stderr back and keeps the turn going',
		(event) => {
			expect(shellHookVerdict(event, entry, exit2('tests still fail\n'))).toEqual({
				action: 'skip',
				reason: 'tests still fail',
			})
		},
	)

	it('on pre_compact cancels the compaction', () => {
		expect(shellHookVerdict('pre_compact', entry, exit2('not now'))).toEqual({
			action: 'skip',
			reason: 'not now',
		})
	})

	it.each(['post_tool_use', 'post_tool_use_failure'] as const)(
		'on %s shows the model the stderr beside that result',
		(event) => {
			expect(shellHookVerdict(event, entry, exit2('lint: 3 errors'))).toEqual({
				action: 'continue',
				context: 'lint: 3 errors',
			})
		},
	)

	it.each([
		'permission_request',
		'notification',
		'session_start',
		'session_end',
		'turn_start',
		'post_compact',
	] as const)('on %s is logged and ignored', (event) => {
		const { log, warn } = spyLog()
		expect(shellHookVerdict(event, entry, exit2('x'), log)).toEqual({
			action: 'continue',
		})
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it('falls back to stdout, then to naming the command, for the reason', () => {
		expect(
			shellHookVerdict('pre_tool_use', entry, {
				...ok,
				exitCode: 2,
				stdout: 'from stdout',
			}),
		).toEqual({ action: 'skip', reason: 'from stdout' })
		expect(shellHookVerdict('pre_tool_use', entry, { ...ok, exitCode: 2 })).toEqual({
			action: 'skip',
			reason: 'blocked by hook `x`',
		})
	})

	it('treats any other exit as the hook failing, never as a verdict', () => {
		const { log, warn } = spyLog()
		expect(shellHookVerdict('turn_end', entry, { ...ok, exitCode: 1 }, log)).toEqual({
			action: 'continue',
		})
		expect(shellHookVerdict('pre_tool_use', entry, { ...ok, exitCode: 127 }, log)).toEqual({
			action: 'continue',
		})
		expect(warn).toHaveBeenCalledTimes(2)
	})

	it('does not read JSON on stdout when the exit is not 0', () => {
		expect(
			shellHookVerdict('pre_tool_use', entry, {
				...ok,
				exitCode: 1,
				stdout: JSON.stringify({ decision: 'block', reason: 'ignored' }),
			}),
		).toEqual({ action: 'continue' })
	})
})

describe('plain stdout', () => {
	it('is context on the prompt event only', () => {
		expect(shellHookVerdict('user_prompt_submit', entry, out('branch: main\n'))).toEqual({
			action: 'annotate',
			text: 'branch: main',
		})
		expect(shellHookVerdict('pre_tool_use', entry, out('noise'))).toEqual({
			action: 'continue',
		})
		expect(shellHookVerdict('turn_end', entry, out('noise'))).toEqual({
			action: 'continue',
		})
	})
})

describe('JSON output fields', () => {
	it('decision: "block" with reason refuses a tool call', () => {
		expect(
			shellHookVerdict('pre_tool_use', entry, out({ decision: 'block', reason: 'no pushes' })),
		).toEqual({ action: 'skip', reason: 'no pushes' })
	})

	it('decision: "block" without a reason still refuses, and says who', () => {
		expect(shellHookVerdict('pre_tool_use', entry, out({ decision: 'block' }))).toEqual({
			action: 'skip',
			reason: 'Blocked by hook',
		})
	})

	it('decision: "block" refuses a prompt', () => {
		expect(
			shellHookVerdict('user_prompt_submit', entry, out({ decision: 'block', reason: 'not now' })),
		).toEqual({ action: 'skip', reason: 'not now' })
	})

	it('decision: "approve" is an allow on a tool call', () => {
		expect(
			shellHookVerdict('pre_tool_use', entry, out({ decision: 'approve', reason: 'trusted' })),
		).toEqual({
			action: 'continue',
			permission: { decision: 'allow', reason: 'trusted' },
		})
	})

	it('decision: "block" on a stop event keeps the turn going with the reason', () => {
		expect(
			shellHookVerdict('turn_end', entry, out({ decision: 'block', reason: 'run the tests' })),
		).toEqual({ action: 'skip', reason: 'run the tests' })
	})

	it('decision: "block" on pre_compact cancels the pass', () => {
		expect(
			shellHookVerdict('pre_compact', entry, out({ decision: 'block', reason: 'wait' })),
		).toEqual({ action: 'skip', reason: 'wait' })
	})

	it('decision: "block" after a tool ran is what the model is told about the result', () => {
		expect(
			shellHookVerdict('post_tool_use', entry, out({ decision: 'block', reason: 'wrong file' })),
		).toEqual({ action: 'continue', context: 'wrong file' })
	})

	it('continue: false halts the turn, with stopReason as the reason', () => {
		expect(
			shellHookVerdict('post_tool_use', entry, out({ continue: false, stopReason: 'budget gone' })),
		).toEqual({ action: 'continue', halt: { reason: 'budget gone' } })
		expect(shellHookVerdict('turn_start', entry, out({ continue: false }))).toEqual({
			action: 'continue',
			halt: { reason: 'Stopped by a hook' },
		})
	})

	it('continue: false before a tool also withholds the call', () => {
		expect(
			shellHookVerdict('pre_tool_use', entry, out({ continue: false, stopReason: 'freeze' })),
		).toEqual({ action: 'skip', reason: 'freeze', halt: { reason: 'freeze' } })
	})

	it('continue: false on a prompt ends the turn', () => {
		expect(
			shellHookVerdict('user_prompt_submit', entry, out({ continue: false, stopReason: 'closed' })),
		).toEqual({ action: 'skip', reason: 'closed' })
	})

	it('continue: false on a stop event stops instead of keeping the turn going', () => {
		expect(
			shellHookVerdict(
				'turn_end',
				entry,
				out({
					continue: false,
					stopReason: 'enough',
					decision: 'block',
					reason: 'more',
				}),
			),
		).toEqual({ action: 'continue', halt: { reason: 'enough' } })
	})

	it('continue: true is the same as saying nothing', () => {
		expect(shellHookVerdict('pre_tool_use', entry, out({ continue: true }))).toEqual({
			action: 'continue',
		})
	})

	it('systemMessage is a warning for the operator, kept on the result and logged', () => {
		const { log, warn } = spyLog()
		expect(shellHookVerdict('pre_tool_use', entry, out({ systemMessage: 'careful' }), log)).toEqual(
			{ action: 'continue', notice: 'careful' },
		)
		expect(warn).toHaveBeenCalledWith(
			'hook warning',
			expect.objectContaining({ 'namzu.hook.notice': 'careful' }),
		)
	})

	it('suppressOutput keeps stdout out of the debug log', () => {
		const loud = spyLog()
		shellHookVerdict('pre_tool_use', entry, out({ systemMessage: 'x' }), loud.log)
		expect(loud.debug).toHaveBeenCalledTimes(1)
		const quiet = spyLog()
		shellHookVerdict(
			'pre_tool_use',
			entry,
			out({ systemMessage: 'x', suppressOutput: true }),
			quiet.log,
		)
		expect(quiet.debug).not.toHaveBeenCalled()
	})

	it('hookSpecificOutput.additionalContext reaches the model on each event that carries it', () => {
		const json = (name: string) => ({
			hookSpecificOutput: {
				hookEventName: name,
				additionalContext: ' remember the migration ',
			},
		})
		expect(shellHookVerdict('pre_tool_use', entry, out(json('PreToolUse')))).toEqual({
			action: 'continue',
			context: 'remember the migration',
		})
		expect(shellHookVerdict('post_tool_use', entry, out(json('PostToolUse')))).toEqual({
			action: 'continue',
			context: 'remember the migration',
		})
		expect(
			shellHookVerdict('post_tool_use_failure', entry, out(json('PostToolUseFailure'))),
		).toEqual({ action: 'continue', context: 'remember the migration' })
		expect(shellHookVerdict('user_prompt_submit', entry, out(json('UserPromptSubmit')))).toEqual({
			action: 'annotate',
			text: 'remember the migration',
		})
		// Feedback on a stop event: the conversation continues so the model can act on it.
		expect(shellHookVerdict('turn_end', entry, out(json('Stop')))).toEqual({
			action: 'skip',
			reason: 'remember the migration',
		})
		expect(shellHookVerdict('subagent_stop', entry, out(json('SubagentStop')))).toEqual({
			action: 'skip',
			reason: 'remember the migration',
		})
	})

	it('accepts Namzu’s own event name in hookEventName as well', () => {
		expect(
			shellHookVerdict(
				'pre_tool_use',
				entry,
				out({
					hookSpecificOutput: {
						hookEventName: 'pre_tool_use',
						additionalContext: 'a',
					},
				}),
			),
		).toEqual({ action: 'continue', context: 'a' })
	})

	it.each([
		['allow', { decision: 'allow' }],
		['ask', { decision: 'ask' }],
	] as const)('permissionDecision "%s" is carried as the hook’s answer', (word, permission) => {
		expect(
			shellHookVerdict(
				'pre_tool_use',
				entry,
				out({
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: word,
						permissionDecisionReason: 'because',
					},
				}),
			),
		).toEqual({
			action: 'continue',
			permission: { ...permission, reason: 'because' },
		})
	})

	it('permissionDecision "deny" refuses, with permissionDecisionReason, then reason, then a default', () => {
		const deny = (extra: object, top: object = {}) =>
			shellHookVerdict(
				'pre_tool_use',
				entry,
				out({
					...top,
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: 'deny',
						...extra,
					},
				}),
			)
		expect(deny({ permissionDecisionReason: 'specific' }, { reason: 'general' })).toEqual({
			action: 'skip',
			reason: 'specific',
		})
		expect(deny({}, { reason: 'general' })).toEqual({
			action: 'skip',
			reason: 'general',
		})
		expect(deny({})).toEqual({ action: 'skip', reason: 'Blocked by hook' })
	})

	it('permissionDecision "defer" decides nothing', () => {
		expect(
			shellHookVerdict(
				'pre_tool_use',
				entry,
				out({
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: 'defer',
					},
				}),
			),
		).toEqual({ action: 'continue' })
	})

	it('updatedInput rewrites the call, and can ride with an allow', () => {
		expect(
			shellHookVerdict(
				'pre_tool_use',
				entry,
				out({
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						updatedInput: { command: 'git status' },
						permissionDecision: 'allow',
					},
				}),
			),
		).toEqual({
			action: 'modify',
			input: { command: 'git status' },
			permission: { decision: 'allow' },
		})
	})

	it('a deny beats an updatedInput in the same answer', () => {
		expect(
			shellHookVerdict(
				'pre_tool_use',
				entry,
				out({
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: 'deny',
						permissionDecisionReason: 'no',
						updatedInput: { command: 'ls' },
					},
				}),
			),
		).toEqual({ action: 'skip', reason: 'no' })
	})

	it('permission_request: allow, deny with message, and deny with interrupt', () => {
		const answer = (decision: object) =>
			out({
				hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
			})
		expect(shellHookVerdict('permission_request', entry, answer({ behavior: 'allow' }))).toEqual({
			action: 'continue',
			permission: { decision: 'allow' },
		})
		expect(
			shellHookVerdict('permission_request', entry, answer({ behavior: 'deny', message: 'nope' })),
		).toEqual({ action: 'skip', reason: 'nope' })
		expect(
			shellHookVerdict(
				'permission_request',
				entry,
				answer({ behavior: 'deny', message: 'stop all', interrupt: true }),
			),
		).toEqual({
			action: 'skip',
			reason: 'stop all',
			halt: { reason: 'stop all' },
		})
		expect(shellHookVerdict('permission_request', entry, answer({ behavior: 'deny' }))).toEqual({
			action: 'skip',
			reason: 'Denied by hook',
		})
	})

	it('notification never blocks, whatever it prints', () => {
		expect(
			shellHookVerdict(
				'notification',
				entry,
				out({
					decision: 'block',
					hookSpecificOutput: {
						hookEventName: 'Notification',
						additionalContext: 'x',
					},
				}),
			),
		).toEqual({ action: 'continue' })
	})
})

describe('JSON that is not a valid answer', () => {
	it.each([
		['not JSON at all after a brace', '{ nope'],
		['a wrong type for continue', { continue: 'no' }],
		['a wrong type for reason', { reason: 3 }],
		['an unknown decision', { decision: 'allow' }],
		[
			'hookSpecificOutput without its event name',
			{ hookSpecificOutput: { additionalContext: 'a' } },
		],
		[
			'hookSpecificOutput naming another event',
			{ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'a' } },
		],
		[
			'an unknown permissionDecision',
			{
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'maybe',
				},
			},
		],
		[
			'updatedInput that is not an object',
			{
				hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: 'ls' },
			},
		],
	])('sets aside %s and carries on, reporting it', (_name, stdout) => {
		const { log, warn } = spyLog()
		const result = shellHookVerdict('pre_tool_use', entry, out(stdout), log)
		// Nothing in an invalid answer may be half-obeyed, a block least of all.
		expect(result).toEqual({ action: 'continue' })
		expect(warn).toHaveBeenCalledWith('hook output ignored', expect.any(Object))
	})

	it('prose that does not start with a brace is plain text, not JSON', () => {
		const { log, warn } = spyLog()
		expect(shellHookVerdict('pre_tool_use', entry, out('all good'), log)).toEqual({
			action: 'continue',
		})
		expect(warn).not.toHaveBeenCalled()
	})
})

describe('matcher', () => {
	it('keeps the list-and-prefix spelling', () => {
		expect(shellHookMatches('edit|write', 'write')).toBe(true)
		expect(shellHookMatches('edit,write', 'write')).toBe(true)
		expect(shellHookMatches('mcp_*', 'mcp_tickets_create')).toBe(true)
		expect(shellHookMatches('mcp_*', 'read')).toBe(false)
		expect(shellHookMatches('bash', 'bash2')).toBe(false)
	})

	it('reads anything else as a regular expression, tested unanchored', () => {
		expect(shellHookMatches('^(edit|write)$', 'write')).toBe(true)
		expect(shellHookMatches('^(edit|write)$', 'rewrite')).toBe(false)
		expect(shellHookMatches('mcp__.*__create', 'mcp__tickets__create')).toBe(true)
		expect(shellHookMatches('^read_.+', 'read_file')).toBe(true)
	})

	it('a regular expression that does not compile matches nothing', () => {
		expect(shellHookMatches('(unclosed', 'anything')).toBe(false)
	})

	it('empty and * match everything; a name-less event matches only those', () => {
		expect(shellHookMatches('', 'bash')).toBe(true)
		expect(shellHookMatches('*', undefined)).toBe(true)
		expect(shellHookMatches('^bash$', undefined)).toBe(false)
	})
})

describe('the `if` filter', () => {
	it('is satisfied by any call when absent', () => {
		expect(shellHookIfMatches(undefined, 'bash', { command: 'ls' })).toBe(true)
	})

	it('names a tool, case-insensitively and in the skill spellings', () => {
		expect(shellHookIfMatches('bash', 'bash', { command: 'ls' })).toBe(true)
		expect(shellHookIfMatches('Bash', 'bash', { command: 'ls' })).toBe(true)
		expect(shellHookIfMatches('Bash', 'read', { path: 'a' })).toBe(false)
		expect(shellHookIfMatches('WebFetch', 'web_fetch', {})).toBe(true)
	})

	it('matches a shell command by pattern, per command in the line', () => {
		expect(shellHookIfMatches('Bash(git *)', 'bash', { command: 'git status' })).toBe(true)
		expect(shellHookIfMatches('Bash(git *)', 'bash', { command: 'ls' })).toBe(false)
		// A guard on `git push` must see it behind a `cd`, or the filter is a hole.
		expect(
			shellHookIfMatches('Bash(git push *)', 'bash', {
				command: 'cd x && git push origin',
			}),
		).toBe(true)
		expect(
			shellHookIfMatches('Bash(git push *)', 'bash', {
				command: 'cd x && git status',
			}),
		).toBe(false)
		expect(
			shellHookIfMatches('Bash(npm run test:*)', 'bash', {
				command: 'npm run test unit',
			}),
		).toBe(true)
	})

	it('runs the hook when the line cannot be read, never skips it', () => {
		expect(
			shellHookIfMatches('Bash(git push *)', 'bash', {
				command: 'eval "$CMD"',
			}),
		).toBe(true)
	})

	it('runs the hook when the filter cannot be read or means nothing for the tool', () => {
		expect(shellHookIfMatches('???', 'bash', { command: 'ls' })).toBe(true)
		expect(shellHookIfMatches('Read(src/**)', 'read', { path: 'a' })).toBe(true)
	})
})

describe('createShellHook', () => {
	const context = (extra: Partial<PluginHookContext> = {}): PluginHookContext =>
		({
			sessionId: asSessionId('0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'),
			turnId: asTurnId('23ebee71-76bb-4e8e-b30f-e5183b1eba11'),
			pluginId: SHELL_HOOKS_PLUGIN_ID,
			event: 'pre_tool_use',
			toolName: 'bash',
			toolInput: { command: 'git status' },
			...extra,
		}) as PluginHookContext

	it('does not spawn at all when `if` rules the call out', async () => {
		const hook = createShellHook(
			'pre_tool_use',
			{ command: 'echo spawned >&2; exit 2', if: 'Bash(git push *)' },
			{ cwd: process.cwd() },
		)
		expect(await hook.handler(context())).toEqual({ action: 'continue' })
		expect(await hook.handler(context({ toolInput: { command: 'git push origin main' } }))).toEqual(
			{ action: 'skip', reason: 'spawned' },
		)
	})

	it('with once, runs a single time in the session and then stays silent', async () => {
		const hook = createShellHook(
			'pre_tool_use',
			{ command: 'echo first >&2; exit 2', once: true },
			{ cwd: process.cwd() },
		)
		expect(await hook.handler(context())).toEqual({
			action: 'skip',
			reason: 'first',
		})
		expect(await hook.handler(context())).toEqual({ action: 'continue' })
	})

	it('a call that did not match does not spend a once hook', async () => {
		const hook = createShellHook(
			'pre_tool_use',
			{ command: 'exit 2', matcher: '^edit$', once: true },
			{ cwd: process.cwd() },
		)
		expect(await hook.handler(context())).toEqual({ action: 'continue' })
		expect((await hook.handler(context({ toolName: 'edit' }))).action).toBe('skip')
	})

	it('carries statusMessage on the definition', () => {
		const hook = createShellHook(
			'post_tool_use',
			{ command: 'exit 0', statusMessage: 'Formatting' },
			{ cwd: process.cwd() },
		)
		expect(hook.statusMessage).toBe('Formatting')
	})

	it('matches a notification on its type', async () => {
		const hook = createShellHook(
			'notification',
			{ command: 'cat >&2; exit 2', matcher: 'approval_required' },
			{ cwd: process.cwd() },
		)
		const notified = (type: 'approval_required' | 'turn_settled') =>
			context({
				event: 'notification',
				toolName: undefined,
				toolInput: undefined,
				notification: { type, message: 'm' },
			})
		const log = spyLog()
		const quiet = createShellHook(
			'notification',
			{ command: 'exit 2', matcher: 'approval_required' },
			{ cwd: process.cwd(), log: log.log },
		)
		await quiet.handler(notified('turn_settled'))
		expect(log.warn, 'a type the matcher does not name never spawns').not.toHaveBeenCalled()
		await quiet.handler(notified('approval_required'))
		expect(log.warn, 'the type it names spawns, and its 2 is logged').toHaveBeenCalledTimes(1)
		expect(hook.event).toBe('notification')
	})
})

describe('real processes', () => {
	const base = {
		cwd: process.cwd(),
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
		turnId: 'f9ad17f0-01b6-4905-810a-3ef3324a614d',
	} as const

	it('reads a heredoc’d JSON answer printed by sh', async () => {
		const outcome = await runShellHook(
			{
				command: `cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"ls"}}}
EOF`,
			},
			{
				...base,
				event: 'pre_tool_use',
				toolName: 'bash',
				toolInput: { command: 'rm -rf x' },
			},
		)
		expect(shellHookVerdict('pre_tool_use', { command: '' }, outcome)).toEqual({
			action: 'modify',
			input: { command: 'ls' },
			permission: { decision: 'allow' },
		})
	})

	it('gives a stop hook stop_hook_active, a notification its type and message, a failure its error', async () => {
		const stop = await runShellHook(
			{ command: 'cat' },
			{ ...base, event: 'turn_end', stopHookActive: true },
		)
		expect(JSON.parse(stop.stdout)).toMatchObject({
			event: 'turn_end',
			stop_hook_active: true,
		})
		const note = await runShellHook(
			{ command: 'cat' },
			{
				...base,
				event: 'notification',
				notification: { type: 'approval_required', message: 'waiting' },
			},
		)
		expect(JSON.parse(note.stdout)).toMatchObject({
			notification_type: 'approval_required',
			message: 'waiting',
		})
		const failure = await runShellHook(
			{ command: 'cat' },
			{
				...base,
				event: 'post_tool_use_failure',
				toolName: 'bash',
				toolResult: { success: false, output: '', error: 'boom' },
			},
		)
		expect(JSON.parse(failure.stdout)).toMatchObject({ error: 'boom' })
	})
})

describe('attachShellHooks with the new events and options', () => {
	it('registers the three new events and passes statusMessage through', () => {
		const registered: PluginHookDefinition[] = []
		const events: ShellHookEvent[] = ['post_tool_use_failure', 'permission_request', 'notification']
		const count = attachShellHooks(
			{
				registerHook: (_id: unknown, hook: PluginHookDefinition) => registered.push(hook),
			} as never,
			Object.fromEntries(
				events.map((event) => [event, [{ command: 'exit 0', statusMessage: `on ${event}` }]]),
			),
			{ cwd: process.cwd() },
		)
		expect(count).toBe(3)
		expect(registered.map((hook) => [hook.event, hook.statusMessage])).toEqual(
			events.map((event) => [event, `on ${event}`]),
		)
	})
})

/**
 * What a session's `session_start` hook can hand the model, the session facts
 * a hook is told (`source`, `reason`), the project folder in its environment,
 * a shell hook's replacement for a tool result, and an `if` filter on a file
 * tool.
 */

import { describe, expect, it, vi } from 'vitest'

import type { PluginHookContext, PluginHookDefinition } from '../../types/plugin/index.js'
import { asSessionId } from '../../utils/id.js'
import {
	MAX_HOOK_CONTEXT_CHARS,
	MAX_HOOK_REPLACEMENT_CHARS,
	frameOperatorHookContext,
	sessionStartHookContext,
} from '../hook-context.js'
import {
	type ShellHookPathFilter,
	createShellHook,
	runShellHook,
	shellHookIfMatches,
	shellHookPayload,
	shellHookVerdict,
} from '../shell-hook.js'

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'
const ok = { exitCode: 0, timedOut: false, stdout: '', stderr: '' }
const out = (stdout: unknown) => ({
	...ok,
	stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
})
const entry = { command: 'x' }

describe('session_start context', () => {
	it('takes plain stdout as context', () => {
		expect(shellHookVerdict('session_start', entry, out('Ticket 4242 is open.\n'))).toEqual({
			action: 'annotate',
			text: 'Ticket 4242 is open.',
		})
	})

	it('takes additionalContext from the JSON answer', () => {
		const verdict = shellHookVerdict(
			'session_start',
			entry,
			out({
				hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ' on call ' },
			}),
		)
		expect(verdict).toEqual({ action: 'annotate', text: 'on call' })
	})

	it('says nothing for a hook that printed nothing', () => {
		expect(shellHookVerdict('session_start', entry, out(''))).toEqual({ action: 'continue' })
	})

	it('still does not turn stdout into context on session_end', () => {
		expect(shellHookVerdict('session_end', entry, out('bye'))).toEqual({ action: 'continue' })
	})

	it('joins what every hook said, in answer order, from continue and annotate alike', () => {
		const text = sessionStartHookContext([
			{ action: 'annotate', text: 'first' },
			{ action: 'continue' },
			{ action: 'continue', context: 'second' },
			{ action: 'annotate', text: '   ' },
		])
		expect(text).toBe('first\n\nsecond')
		expect(sessionStartHookContext([{ action: 'continue' }])).toBeUndefined()
	})

	it('bounds the text and marks the cut', () => {
		const text = sessionStartHookContext([
			{ action: 'annotate', text: 'x'.repeat(MAX_HOOK_CONTEXT_CHARS + 500) },
		])
		expect(text?.length).toBe(MAX_HOOK_CONTEXT_CHARS + '\n[truncated]'.length)
		expect(text?.endsWith('[truncated]')).toBe(true)
	})

	it('frames it as the operator hooks speaking, the way prompt context is', () => {
		expect(frameOperatorHookContext(['a', 'b'])).toBe(
			"Context from the operator's hooks:\n\na\n\nb",
		)
	})
})

describe('what a session hook is told', () => {
	it('sends source on session_start and reason on session_end', () => {
		const start = JSON.parse(
			shellHookPayload({
				event: 'session_start',
				cwd: '/p',
				sessionId: SESSION,
				sessionSource: 'resume',
			}),
		)
		expect(start.source).toBe('resume')
		expect(start.reason).toBeUndefined()
		const end = JSON.parse(
			shellHookPayload({
				event: 'session_end',
				cwd: '/p',
				sessionId: SESSION,
				endReason: 'replaced',
			}),
		)
		expect(end.reason).toBe('replaced')
		expect(end.source).toBeUndefined()
	})

	function contextOf(event: 'session_start' | 'session_end', extra: Partial<PluginHookContext>) {
		return { event, sessionId: asSessionId(SESSION), ...extra } as PluginHookContext
	}

	async function runs(
		event: 'session_start' | 'session_end',
		matcher: string,
		extra: Partial<PluginHookContext>,
	): Promise<boolean> {
		// `printf` answers with context only if the hook was really started.
		const hook = createShellHook(
			event,
			{ command: 'printf ran', matcher },
			{ cwd: process.cwd() },
		) as PluginHookDefinition & {
			handler: (c: PluginHookContext) => Promise<{ action: string; text?: string }>
		}
		const verdict = await hook.handler(contextOf(event, extra))
		return verdict.action === 'annotate' || verdict.action === 'continue'
			? verdict.action === 'annotate'
			: false
	}

	it('tests a matcher on session_start against the source', async () => {
		expect(await runs('session_start', 'resume', { source: 'resume' })).toBe(true)
		expect(await runs('session_start', 'resume', { source: 'startup' })).toBe(false)
		expect(await runs('session_start', 'startup|resume', { source: 'startup' })).toBe(true)
	})

	it('names the clear values: a start matcher tests the source and the payload sends the reason', async () => {
		expect(await runs('session_start', 'clear', { source: 'clear' })).toBe(true)
		expect(await runs('session_start', 'clear', { source: 'startup' })).toBe(false)
		expect(await runs('session_start', 'startup|clear', { source: 'clear' })).toBe(true)
		const end = JSON.parse(
			shellHookPayload({
				event: 'session_end',
				cwd: '/p',
				sessionId: SESSION,
				endReason: 'clear',
			}),
		)
		expect(end.reason).toBe('clear')
	})

	it('tests a matcher on session_end against the reason', async () => {
		const hook = createShellHook(
			'session_end',
			{ command: 'cat', matcher: 'replaced', async: false },
			{ cwd: process.cwd() },
		) as PluginHookDefinition & { handler: (c: PluginHookContext) => Promise<unknown> }
		// A non-matching reason never starts the process: `exit` does not match `replaced`.
		await expect(hook.handler(contextOf('session_end', { endReason: 'exit' }))).resolves.toEqual({
			action: 'continue',
		})
	})
})

describe('NAMZU_PROJECT_DIR', () => {
	const base = { event: 'turn_start', sessionId: SESSION } as const

	it('is the folder the session was started for, not the hook process directory', async () => {
		const outcome = await runShellHookPrinting('"$NAMZU_PROJECT_DIR"', {
			...base,
			cwd: process.cwd(),
			projectDir: '/somewhere/else',
		})
		expect(outcome.stdout).toBe('/somewhere/else')
	})

	it('falls back to cwd when the host names none', async () => {
		const outcome = await runShellHookPrinting('"$NAMZU_PROJECT_DIR"', {
			...base,
			cwd: process.cwd(),
		})
		expect(outcome.stdout).toBe(process.cwd())
	})

	function runShellHookPrinting(what: string, input: Parameters<typeof runShellHook>[1]) {
		return runShellHook({ command: `printf %s ${what}` }, input)
	}
})

describe('a shell hook replaces a tool result', () => {
	const reply = (extra: Record<string, unknown>) =>
		out({ hookSpecificOutput: { hookEventName: 'PostToolUse', ...extra } })

	it('answers replace with the text, marked for disclosure', () => {
		expect(
			shellHookVerdict('post_tool_use', entry, reply({ updatedToolOutput: 'key=[redacted]' })),
		).toEqual({ action: 'replace', output: 'key=[redacted]', disclose: true })
	})

	it('keeps additionalContext beside the replacement', () => {
		expect(
			shellHookVerdict(
				'post_tool_use',
				entry,
				reply({ updatedToolOutput: 'x', additionalContext: 'one secret was removed' }),
			),
		).toEqual({
			action: 'replace',
			output: 'x',
			disclose: true,
			context: 'one secret was removed',
		})
	})

	it('allows an empty replacement', () => {
		expect(shellHookVerdict('post_tool_use', entry, reply({ updatedToolOutput: '' }))).toEqual({
			action: 'replace',
			output: '',
			disclose: true,
		})
	})

	it('bounds a long replacement and marks the cut', () => {
		const verdict = shellHookVerdict(
			'post_tool_use',
			entry,
			reply({ updatedToolOutput: 'y'.repeat(MAX_HOOK_REPLACEMENT_CHARS + 10) }),
		)
		expect(verdict.action).toBe('replace')
		if (verdict.action === 'replace') {
			expect(verdict.output.length).toBe(MAX_HOOK_REPLACEMENT_CHARS + '\n[truncated]'.length)
		}
	})

	it('reads an answer of 64 KiB at most: a larger one is set aside (and, with onFailure block, the result is withheld)', async () => {
		const answering = (chars: number) =>
			runShellHook(
				{
					command: `printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"'; head -c ${chars} /dev/zero | tr '\\0' y; printf '"}}'`,
				},
				{ event: 'post_tool_use', sessionId: SESSION, cwd: process.cwd() },
			)
		const within = shellHookVerdict('post_tool_use', entry, await answering(33_000))
		expect(within.action).toBe('replace')
		const over = shellHookVerdict('post_tool_use', entry, await answering(100_000))
		expect(over.action).not.toBe('replace')
	})

	it('reads a replacement that is not text as its JSON text', () => {
		expect(shellHookVerdict('post_tool_use', entry, reply({ updatedToolOutput: 5 }))).toMatchObject(
			{
				action: 'replace',
				output: '5',
			},
		)
	})

	it('replaces on post_tool_use_failure too, so a hook attached only there still redacts', () => {
		expect(
			shellHookVerdict(
				'post_tool_use_failure',
				entry,
				out({
					hookSpecificOutput: { hookEventName: 'PostToolUseFailure', updatedToolOutput: 'z' },
				}),
			),
		).toMatchObject({ action: 'replace', output: 'z', disclose: true })
	})
})

describe('if on a file tool', () => {
	// Stands in for the host's permission-rule reading: `src/` files only.
	const filter: ShellHookPathFilter = (tool, pattern, callTool, input) => {
		if (tool !== 'edit' && tool !== 'read') return undefined
		const covered = tool === 'edit' ? ['edit', 'write'] : ['read']
		if (!covered.includes(callTool)) return false
		const path = (input as { path?: string }).path
		if (path === undefined) return undefined
		return pattern === 'src' ? path.startsWith('src/') : false
	}

	it('runs for a path the host says is named, and not for another', () => {
		expect(shellHookIfMatches('Edit(src)', 'edit', { path: 'src/a.ts' }, filter)).toBe(true)
		expect(shellHookIfMatches('Edit(src)', 'edit', { path: 'docs/a.md' }, filter)).toBe(false)
	})

	it('reads an Edit filter for write too, as the permission rules do', () => {
		expect(shellHookIfMatches('Edit(src)', 'write', { path: 'src/b.ts' }, filter)).toBe(true)
		expect(shellHookIfMatches('Edit(src)', 'read', { path: 'src/b.ts' }, filter)).toBe(false)
	})

	it('runs the hook when the call has no path to compare', () => {
		expect(shellHookIfMatches('Edit(src)', 'edit', {}, filter)).toBe(true)
	})

	it('is unchanged for bash and for a bare tool name', () => {
		expect(
			shellHookIfMatches('Bash(git push *)', 'bash', { command: 'git push origin' }, filter),
		).toBe(true)
		expect(shellHookIfMatches('Bash(git push *)', 'bash', { command: 'ls' }, filter)).toBe(false)
		expect(shellHookIfMatches('Edit', 'edit', { path: 'x' }, filter)).toBe(true)
		expect(shellHookIfMatches('Edit', 'write', { path: 'x' }, filter)).toBe(false)
	})

	it('runs the hook for a file tool when the host reads no paths, so a typo never switches a guard off', () => {
		expect(shellHookIfMatches('Edit(src)', 'edit', { path: 'docs/a.md' })).toBe(true)
	})
})

describe('a post_tool_use hook that fails', () => {
	const tooLarge = () =>
		runShellHook(
			{
				command: `printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"'; head -c 100000 /dev/zero | tr '\\0' y; printf '"}}'`,
			},
			{ event: 'post_tool_use', sessionId: SESSION, cwd: process.cwd() },
		)
	const run = (spec: object) =>
		runShellHook(spec as never, { event: 'post_tool_use', sessionId: SESSION, cwd: process.cwd() })
	const cases: [string, () => ReturnType<typeof runShellHook>, string][] = [
		['printed an answer over the limit', tooLarge, 'answer is too large'],
		['timed out', () => run({ command: 'sleep 30', timeoutMs: 50 }), 'timed out'],
		[
			'could not start',
			() => run({ command: '/nonexistent/namzu-hook-binary', args: [] }),
			'could not start',
		],
		['exited with a code other than 0 or 2', () => run({ command: 'exit 3' }), 'exited with 3'],
	]

	for (const [what, outcome, reason] of cases) {
		for (const event of ['post_tool_use', 'post_tool_use_failure'] as const) {
			it(`${event}: onFailure block withholds the result when it ${what}`, async () => {
				const verdict = shellHookVerdict(
					event,
					{ command: 'x', onFailure: 'block' },
					await outcome(),
				)
				expect(verdict.action).toBe('replace')
				if (verdict.action !== 'replace') return
				expect(verdict.disclose).toBe(true)
				expect(verdict.output).toContain('A hook guarding this result failed')
				expect(verdict.output).toContain('the result is not shown')
				expect(verdict.output).toContain(reason)
				expect(verdict.content).toEqual([{ type: 'text', text: verdict.output }])
			})

			it(`${event}: onFailure continue leaves the result alone when it ${what}`, async () => {
				expect(shellHookVerdict(event, { command: 'x' }, await outcome())).toEqual({
					action: 'continue',
				})
				expect(
					shellHookVerdict(event, { command: 'x', onFailure: 'continue' }, await outcome()),
				).toEqual({ action: 'continue' })
			})
		}
	}

	it('names the limit when the answer is too large, not generic unreadable JSON', async () => {
		const warn = vi.fn()
		const log = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log } as never
		shellHookVerdict('post_tool_use', entry, await tooLarge(), log)
		expect(JSON.stringify(warn.mock.calls)).toContain('65536')
		expect(JSON.stringify(warn.mock.calls)).not.toContain('not valid JSON')
	})

	it('keeps the parser detail out of the line the model reads', () => {
		const verdict = shellHookVerdict(
			'post_tool_use',
			{ command: 'x', onFailure: 'block' },
			out('{"updatedToolOutput": "hunter2" oops'),
		)
		expect(verdict.action).toBe('replace')
		if (verdict.action === 'replace') expect(verdict.output).not.toContain('hunter2')
	})

	it('does not change a pre_tool_use hook: block still refuses the call', async () => {
		const verdict = shellHookVerdict(
			'pre_tool_use',
			{ command: 'x', onFailure: 'block' },
			await run({ command: 'exit 3' }),
		)
		expect(verdict.action).toBe('skip')
	})
})

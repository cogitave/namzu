/**
 * A `matcher` names a tool the way an entry's `if` does: without regard to
 * case and through the names skills write. A guard may fire for more calls
 * than it did, never for fewer.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { SKILL_TOOL_NAME_ALIASES } from '../../authorization/skill-grant.js'
import type { PluginHookContext, PluginHookDefinition } from '../../types/plugin/index.js'
import { asSessionId } from '../../utils/id.js'
import { MAX_SHELL_HOOK_TIMEOUT_MS, createShellHook, shellHookMatches } from '../shell-hook.js'

const tool = { tool: true } as const

describe('shellHookMatches on a tool event', () => {
	it.each([
		['bash', 'bash'],
		['Bash', 'bash'],
		['BASH', 'bash'],
		['Edit', 'edit'],
		['MultiEdit', 'edit'],
		['WebFetch', 'web_fetch'],
		['Agent', 'create_task'],
		['Task', 'create_task'],
		['KillShell', 'job'],
	])('an exact name %s matches the tool %s', (matcher, name) => {
		expect(shellHookMatches(matcher, name, tool)).toBe(true)
	})

	it('a list takes the real name, the written name and an alias', () => {
		expect(shellHookMatches('Edit|Write', 'edit', tool)).toBe(true)
		expect(shellHookMatches('Edit|Write', 'write', tool)).toBe(true)
		expect(shellHookMatches('edit, WRITE', 'write', tool)).toBe(true)
		expect(shellHookMatches('MultiEdit|Write', 'edit', tool)).toBe(true)
		expect(shellHookMatches('Edit|Write', 'read', tool)).toBe(false)
	})

	it('a prefix is read the same way', () => {
		expect(shellHookMatches('mcp_*', 'mcp_tickets_create', tool)).toBe(true)
		expect(shellHookMatches('MCP_*', 'mcp_tickets_create', tool)).toBe(true)
		expect(shellHookMatches('Web*', 'web_fetch', tool)).toBe(true)
		expect(shellHookMatches('WebFetch*', 'web_fetch', tool)).toBe(true)
		expect(shellHookMatches('Web*', 'read', tool)).toBe(false)
	})

	it('a regular expression still tests the real name, and also the written names', () => {
		// As before: the real name.
		expect(shellHookMatches('^(edit|write)$', 'write', tool)).toBe(true)
		expect(shellHookMatches('^b.sh$', 'bash', tool)).toBe(true)
		// Written for the names skills write.
		expect(shellHookMatches('Bash.*', 'bash', tool)).toBe(true)
		expect(shellHookMatches('^(Edit|Write)$', 'edit', tool)).toBe(true)
		expect(shellHookMatches('^(Edit|Write)$', 'write', tool)).toBe(true)
		expect(shellHookMatches('^MultiEdit$', 'edit', tool)).toBe(true)
		expect(shellHookMatches('^WebFetch$', 'web_fetch', tool)).toBe(true)
		// Still not a match.
		expect(shellHookMatches('^(Edit|Write)$', 'read', tool)).toBe(false)
		expect(shellHookMatches('^Bash$', 'bash_job', tool)).toBe(false)
		expect(shellHookMatches('(', 'bash', tool)).toBe(false)
	})

	it('a name that is not the tool does not match', () => {
		expect(shellHookMatches('Bash', 'read', tool)).toBe(false)
		expect(shellHookMatches('Read', 'bash', tool)).toBe(false)
		expect(shellHookMatches('Bash', undefined, tool)).toBe(false)
	})

	it('never matches less than the exact comparison did', () => {
		for (const name of ['bash', 'task', 'agent', 'create_task', 'mcp__x__y', 'web_fetch']) {
			expect(shellHookMatches(name, name, tool)).toBe(true)
			expect(shellHookMatches(`${name.slice(0, 3)}*`, name, tool)).toBe(true)
			expect(shellHookMatches(`^${name}$`, name, tool)).toBe(true)
		}
	})

	it('every alias has a written spelling that matches its tool', () => {
		const written = [
			'Read',
			'Write',
			'Edit',
			'MultiEdit',
			'Bash',
			'Grep',
			'Glob',
			'LS',
			'WebFetch',
			'WebSearch',
			'Skill',
			'AskUserQuestion',
			'Task',
			'Agent',
			'LSP',
			'ToolSearch',
			'BashOutput',
			'TaskOutput',
			'KillShell',
			'KillBash',
			'TaskStop',
			'TaskCreate',
			'TaskUpdate',
			'TaskList',
		]
		// One written name for each alias key, so a new alias fails here until it is spelled.
		expect(written.map((each) => each.toLowerCase()).sort()).toEqual(
			Object.keys(SKILL_TOOL_NAME_ALIASES).sort(),
		)
		for (const each of written) {
			const target = SKILL_TOOL_NAME_ALIASES[each.toLowerCase()] as string
			expect(shellHookMatches(`^${each}$`, target, tool)).toBe(true)
		}
	})
})

describe('shellHookMatches where the name is not a tool', () => {
	it('ignores case and takes no tool alias', () => {
		expect(shellHookMatches('Startup', 'startup')).toBe(true)
		expect(shellHookMatches('startup|RESUME', 'resume')).toBe(true)
		expect(shellHookMatches('permission_*', 'Permission_prompt')).toBe(true)
		expect(shellHookMatches('Explore', 'explore')).toBe(true)
		// `Bash` is an alias of `bash` only for a tool; an agent named `bash` is not `Bash`'s alias target.
		expect(shellHookMatches('Task', 'create_task')).toBe(false)
		expect(shellHookMatches('Agent', 'create_task')).toBe(false)
		expect(shellHookMatches('^Task$', 'create_task')).toBe(false)
	})

	it('keeps a regular expression exactly as it was', () => {
		expect(shellHookMatches('^Explore$', 'explore')).toBe(false)
		expect(shellHookMatches('^explore$', 'explore')).toBe(true)
	})

	it('createShellHook reads the matcher on a notification and a session event without aliases', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'matcher-names-'))
		try {
			const run = async (event: 'notification' | 'session_start', matcher: string, ctx: object) => {
				const marker = join(dir, `${event}-${matcher}`)
				const hook = createShellHook(
					event,
					{ command: `touch '${marker}'`, matcher },
					{ cwd: process.cwd() },
				) as PluginHookDefinition & { handler: (c: PluginHookContext) => Promise<unknown> }
				await hook.handler({
					event,
					sessionId: asSessionId('0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'),
					...ctx,
				} as PluginHookContext)
				return existsSync(marker)
			}
			expect(await run('session_start', 'Resume', { source: 'resume' })).toBe(true)
			expect(await run('session_start', 'Bash', { source: 'resume' })).toBe(false)
			expect(
				await run('notification', 'Idle_Prompt', {
					notification: { type: 'idle_prompt', message: '' },
				}),
			).toBe(true)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe('a hook on a tool call, through the definition', () => {
	it('a matcher written as `Bash` runs for the tool `bash`', async () => {
		const hook = createShellHook(
			'pre_tool_use',
			{ command: 'echo no >&2; exit 2', matcher: 'Bash' },
			{ cwd: process.cwd() },
		) as PluginHookDefinition & {
			handler: (c: PluginHookContext) => Promise<{ action: string }>
		}
		const verdict = await hook.handler({
			event: 'pre_tool_use',
			sessionId: asSessionId('0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'),
			toolName: 'bash',
			toolInput: { command: 'ls' },
		} as PluginHookContext)
		expect(verdict.action).toBe('skip')
	})
})

describe('the session_end default deadline', () => {
	const context = {
		event: 'session_end',
		sessionId: asSessionId('0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'),
		endReason: 'exit',
	} as PluginHookContext

	/**
	 * Runs `sleep 30` as a session_end hook on a clock the test moves: the
	 * clock goes `advance` ms, then to the cap so the process is always ended
	 * before the test returns. What the test reads is the deadline the hook
	 * was armed with, as reported when it was ended.
	 */
	async function runWith(
		entry: { timeoutMs?: number },
		options: { defaultTimeoutMs?: { session_end?: number } },
		advance: number,
	) {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const onTimeout = vi.fn()
			const hook = createShellHook(
				'session_end',
				{ command: 'sleep 30', ...entry },
				{ cwd: process.cwd(), onTimeout, ...options },
			) as PluginHookDefinition & { handler: (c: PluginHookContext) => Promise<unknown> }
			const pending = hook.handler(context)
			// Let the process start before the clock moves.
			await vi.advanceTimersByTimeAsync(1)
			await vi.advanceTimersByTimeAsync(advance)
			await vi.advanceTimersByTimeAsync(MAX_SHELL_HOOK_TIMEOUT_MS)
			await pending
			return { onTimeout }
		} finally {
			vi.useRealTimers()
		}
	}

	it('ends a hook with no timeoutMs at the event default', async () => {
		const { onTimeout } = await runWith({}, { defaultTimeoutMs: { session_end: 5000 } }, 5000)
		expect(onTimeout).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'session_end', hook: 'sleep 30', timeoutMs: 5000 }),
		)
	})

	it('honours the entry timeoutMs as written, not the default', async () => {
		const { onTimeout } = await runWith(
			{ timeoutMs: 20000 },
			{ defaultTimeoutMs: { session_end: 5000 } },
			5000,
		)
		expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 20000 }))
	})

	it('changes nothing when the option is absent', async () => {
		const { onTimeout } = await runWith({}, {}, 5000)
		expect(onTimeout).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutMs: MAX_SHELL_HOOK_TIMEOUT_MS }),
		)
	})
})

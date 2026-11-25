import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	AuthorizationGate,
	type AuthorizationRule,
	NOOP_LOGGER,
	type PluginHookResult,
	type PluginId,
	SHELL_OFF_PLACEHOLDER,
	SHELL_REMOTE_PLACEHOLDER,
	SHELL_UNTRUSTED_PLACEHOLDER,
} from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
	NO_SKILL_SHELL,
	type SessionSkillShellDeps,
	type SkillShellRequest,
	createSessionSkillShell,
	shellBlockFor,
} from './skill-shell.js'

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-skill-shell-')))

const gateWith = (...rules: AuthorizationRule[]) =>
	new AuthorizationGate(
		{
			enabled: true,
			rules,
			allowReadOnlyTools: false,
			denyDangerousPatterns: true,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)

const allowBash: AuthorizationRule = { type: 'allow_by_name', toolNames: ['bash'] }

function shell(overrides: Partial<SessionSkillShellDeps> = {}) {
	const warnings: string[] = []
	const deps: SessionSkillShellDeps = {
		cwd: () => cwd,
		disabled: () => false,
		trusted: () => true,
		gate: () => gateWith(allowBash),
		hooks: () => undefined,
		sessionId: () => '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
		warn: (line) => warnings.push(line),
		...overrides,
	}
	return { shell: createSessionSkillShell(deps), warnings }
}

const request = (text: string, more: Partial<SkillShellRequest> = {}): SkillShellRequest => ({
	text,
	name: 'review',
	origin: 'user',
	invokedBy: 'user',
	...more,
})

describe('the commands run in the session’s shell tool', () => {
	it('runs a command in the working folder and puts its output in place', async () => {
		const { shell: run } = shell()
		expect(await run.expand(request('Here: !`pwd`.'))).toBe(`Here: ${cwd}.`)
	})

	it('puts a stderr block after the output', async () => {
		const { shell: run } = shell()
		expect(await run.expand(request('!`echo out; echo err >&2`'))).toBe('out\n[stderr]\nerr')
	})

	it('runs a fenced block as one command', async () => {
		const { shell: run } = shell()
		expect(await run.expand(request('```!\nA=1\necho "a=$A"\n```'))).toBe('a=1')
	})

	it('leaves text with no command as it is', async () => {
		const { shell: run } = shell()
		expect(await run.expand(request('use `ls` here'))).toBe('use `ls` here')
	})

	it('fails the load on a non-zero exit, with the output', async () => {
		const { shell: run } = shell()
		await expect(run.expand(request('!`echo nope >&2; exit 3`'))).rejects.toMatchObject({
			reason: 'failed',
			message: expect.stringContaining('[stderr]\nnope'),
		})
	})
})

describe('permission', () => {
	it('fails the load for a command a rule denies, with the rule’s words', async () => {
		const { shell: run } = shell({
			gate: () => gateWith({ type: 'deny_by_name', toolNames: ['bash'] }),
		})
		await expect(run.expand(request('!`ls`'))).rejects.toMatchObject({
			reason: 'permission',
			message: expect.stringContaining('denied by name'),
		})
	})

	it('fails the load for a command no rule allows, because a load cannot ask', async () => {
		const { shell: run } = shell({ gate: () => gateWith() })
		await expect(run.expand(request('!`ls`'))).rejects.toMatchObject({
			reason: 'permission',
			message: expect.stringContaining('cannot wait for approval'),
		})
	})

	it('lets allowed-tools answer a command no rule decided, and only that one', async () => {
		const { shell: run } = shell({ gate: () => gateWith() })
		expect(await run.expand(request('!`echo hi`', { allowedTools: 'Bash(echo *)' }))).toBe('hi')
		await expect(
			run.expand(request('!`printf x`', { allowedTools: 'Bash(echo *)' })),
		).rejects.toMatchObject({ reason: 'permission' })
		// Not carried to the next load.
		await expect(run.expand(request('!`echo hi`'))).rejects.toMatchObject({ reason: 'permission' })
	})

	it('does not let allowed-tools reopen a denial', async () => {
		const { shell: run } = shell({
			gate: () => gateWith({ type: 'deny_by_name', toolNames: ['bash'] }),
		})
		await expect(run.expand(request('!`echo hi`', { allowedTools: 'Bash' }))).rejects.toMatchObject(
			{
				reason: 'permission',
			},
		)
	})

	it('never runs what the dangerous-command floor refuses, whatever allowed-tools says', async () => {
		const { shell: run } = shell({ gate: () => gateWith() })
		await expect(
			run.expand(request('!`rm -rf /`', { allowedTools: 'Bash' })),
		).rejects.toMatchObject({ reason: 'permission' })
	})
})

describe('the session’s permission mode', () => {
	const touch = (name: string) => `!\`touch ${name}\``
	const grant = { allowedTools: 'Bash(touch *)' }

	it.each(['plan', 'strict'])(
		'refuses a command that changes something in %s mode, though allowed-tools grants it',
		async (mode) => {
			const { shell: run } = shell({ gate: () => gateWith() })
			await expect(run.expand(request(touch('mode-a'), { ...grant, mode }))).rejects.toMatchObject({
				reason: 'permission',
				message: expect.stringContaining(`${mode} mode`),
			})
			expect(existsSync(join(cwd, 'mode-a'))).toBe(false)
		},
	)

	it('names the command and the mode in the line that fails the load', async () => {
		const { shell: run } = shell()
		await expect(run.expand(request(touch('mode-b'), { mode: 'plan' }))).rejects.toThrow(
			/pattern "touch mode-b": plan mode/,
		)
	})

	it('refuses in plan mode even when a rule allows every shell command', async () => {
		const { shell: run } = shell({ gate: () => gateWith(allowBash) })
		await expect(run.expand(request(touch('mode-c'), { mode: 'plan' }))).rejects.toMatchObject({
			reason: 'permission',
		})
		expect(existsSync(join(cwd, 'mode-c'))).toBe(false)
	})

	it('runs a command that only reads in plan mode', async () => {
		const { shell: run } = shell({ gate: () => gateWith(allowBash) })
		expect(await run.expand(request('!`echo hi`', { mode: 'plan' }))).toBe('hi')
	})

	it('runs in strict mode what a rule allows by name', async () => {
		const { shell: run } = shell({ gate: () => gateWith(allowBash) })
		expect(await run.expand(request('!`echo hi`', { mode: 'strict' }))).toBe('hi')
	})

	it('reads the session’s mode when the caller names none', async () => {
		const { shell: run } = shell({ gate: () => gateWith(allowBash), mode: () => 'plan' })
		await expect(run.expand(request(touch('mode-d')))).rejects.toMatchObject({
			reason: 'permission',
		})
		expect(existsSync(join(cwd, 'mode-d'))).toBe(false)
	})

	it.each(['prompt', 'accept-edits', 'auto', 'bypass'])(
		'answers as before in %s mode',
		async (mode) => {
			const { shell: run } = shell({ gate: () => gateWith() })
			expect(await run.expand(request('!`echo hi`', { allowedTools: 'Bash(echo *)', mode }))).toBe(
				'hi',
			)
		},
	)
})

describe('the environment a command sees', () => {
	it('leaves out variables whose names look like credentials, and keeps the others', async () => {
		vi.stubEnv('FAKE_SERVICE_API_KEY', 'sk-test-123')
		vi.stubEnv('FAKE_SERVICE_TOKEN', 'sk-test-123')
		vi.stubEnv('FAKE_PLAIN_SETTING', 'plain')
		try {
			const { shell: run } = shell()
			const text = await run.expand(
				request('!`echo "[$FAKE_SERVICE_API_KEY][$FAKE_SERVICE_TOKEN][$FAKE_PLAIN_SETTING]"`'),
			)
			expect(text).toBe('[][][plain]')
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('keeps a variable the host adds on purpose, even one named like a credential', async () => {
		const { shell: run } = shell({ env: () => ({ FAKE_ADDED_TOKEN: 'given' }) })
		expect(await run.expand(request('!`echo "[$FAKE_ADDED_TOKEN]"`'))).toBe('[given]')
	})
})

describe('the switch and the sources', () => {
	it('leaves a placeholder while the switch is on, and runs nothing', async () => {
		const gate = vi.fn(() => gateWith(allowBash))
		const { shell: run } = shell({ disabled: () => true, gate })
		expect(await run.expand(request('a !`pwd` b'))).toBe(`a ${SHELL_OFF_PLACEHOLDER} b`)
		expect(gate).not.toHaveBeenCalled()
	})

	it('reads the switch at each load', async () => {
		let off = false
		const { shell: run } = shell({ disabled: () => off })
		expect(await run.expand(request('!`echo a`'))).toBe('a')
		off = true
		expect(await run.expand(request('!`echo a`'))).toBe(SHELL_OFF_PLACEHOLDER)
	})

	it.each([
		['user', true, 'ran'],
		['user', false, 'ran'],
		['plugin', true, 'ran'],
		['plugin', false, 'ran'],
		['system', false, 'ran'],
		['project', true, 'ran'],
		['project', false, SHELL_UNTRUSTED_PLACEHOLDER],
		['remote', true, SHELL_REMOTE_PLACEHOLDER],
		['remote', false, SHELL_REMOTE_PLACEHOLDER],
	] as const)('%s, folder trusted %s', async (origin, trusted, expected) => {
		const { shell: run } = shell({ trusted: () => trusted })
		const out = await run.expand(request('!`echo ran`', { origin }))
		expect(out).toBe(expected)
	})

	it('maps an origin to its block', () => {
		expect(shellBlockFor('user', false)).toBeUndefined()
		expect(shellBlockFor('project', true)).toBeUndefined()
		expect(shellBlockFor('project', false)).toBe('untrusted')
		expect(shellBlockFor('remote', true)).toBe('remote')
	})

	it('a session with no shell refuses every command', async () => {
		await expect(NO_SKILL_SHELL.expand(request('!`ls`'))).rejects.toMatchObject({
			reason: 'permission',
		})
	})
})

describe('the hook', () => {
	const manager = (answer: (command: string) => PluginHookResult) => {
		const seen: Record<string, unknown>[] = []
		return {
			seen,
			manager: {
				listHooks: () => [{ pluginId: 'p' as PluginId, event: 'pre_skill_shell_command' as const }],
				executeHooks: vi.fn(async (_event: string, context: Record<string, unknown>) => {
					seen.push(context)
					return [answer((context.toolInput as { command: string }).command)]
				}),
			},
		}
	}

	it('is told the command, who asked and where it came from', async () => {
		const { manager: hooks, seen } = manager(() => ({ action: 'continue' }))
		const { shell: run } = shell({ hooks: () => hooks as never })
		await run.expand(request('!`echo a`', { origin: 'plugin', invokedBy: 'other' }))
		expect(seen[0]).toMatchObject({
			toolName: 'bash',
			toolInput: { command: 'echo a' },
			skillShell: { commandName: 'review', commandSource: 'plugin', invokedBy: 'other' },
		})
	})

	it('is not asked for a command the rules refused', async () => {
		const { manager: hooks } = manager(() => ({ action: 'continue' }))
		const { shell: run } = shell({ hooks: () => hooks as never, gate: () => gateWith() })
		await expect(run.expand(request('!`ls`'))).rejects.toBeDefined()
		expect(hooks.executeHooks).not.toHaveBeenCalled()
	})

	it('a refusal leaves a placeholder, warns, and the command does not run', async () => {
		const { manager: hooks } = manager((command) =>
			command === 'touch x' ? { action: 'skip', reason: 'read only here' } : { action: 'continue' },
		)
		const { shell: run, warnings } = shell({ hooks: () => hooks as never })
		const out = await run.expand(request('a !`touch x` b !`echo ok`'))
		expect(out).toBe('a [not run: blocked by hook: read only here] b ok')
		expect(warnings).toEqual(['Not run in /review: touch x (blocked by hook: read only here)'])
	})

	it('a stop fails the load', async () => {
		const { manager: hooks } = manager(() => ({ action: 'continue', halt: { reason: 'freeze' } }))
		const { shell: run } = shell({ hooks: () => hooks as never })
		await expect(run.expand(request('!`echo a`'))).rejects.toMatchObject({
			reason: 'stopped',
			message: '/review was stopped by a hook: freeze',
		})
	})
})

describe('what a command reaches past the working folders', () => {
	it('fails the load for a removal or an outside path even when allowed-tools grants bash', async () => {
		const { shell: run } = shell({ gate: () => gateWith() })
		await expect(run.expand(request('!`rm -rf ~/x`', { allowedTools: 'Bash' }))).rejects.toThrow(
			/review/,
		)
		await expect(
			run.expand(request('!`echo hi > /etc/namzu-test-out`', { allowedTools: 'Bash' })),
		).rejects.toThrow(/review/)
	})

	it('fails the load under an allow-all rule too', async () => {
		const { shell: run } = shell()
		await expect(run.expand(request('!`rm -rf ~/x`'))).rejects.toThrow(/review/)
	})

	it('still runs a command that stays inside the roots', async () => {
		const { shell: run } = shell()
		expect(await run.expand(request('!`echo ok > inside.txt && cat inside.txt`'))).toBe('ok')
	})
})

/**
 * The mode, and its precedence against the config file.
 *
 * The rule being protected is one sentence: a mode governs only the calls no
 * rule decided, so it can never reopen what a rule closed. The tests that
 * matter are the ones that would catch a future change making
 * `--permission-mode auto` able to run something the operator wrote `deny` for.
 */

import { VerificationGate, configureLogger, getRootLogger } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { makeResumeHandler } from '../../tui/agent.js'
import { PERMISSION_MODES, isPermissionMode, resolvePermissionMode } from '../mode.js'
import { compilePermissions } from '../rules.js'

configureLogger({ level: 'silent' })

describe('resolving the mode from flag, alias and terminal', () => {
	it('takes an explicit flag over everything else', () => {
		expect(resolvePermissionMode({ flag: 'strict', interactive: true })).toEqual({ mode: 'strict' })
		expect(
			resolvePermissionMode({ flag: 'prompt', skipPermissions: true, interactive: false }),
		).toEqual({ mode: 'prompt' })
	})

	it('refuses a mode it does not know, and names the ones it does', () => {
		const result = resolvePermissionMode({ flag: 'yolo', interactive: false })

		expect('error' in result && result.error).toContain('prompt, auto, strict')
	})

	it('maps the bypass aliases to auto', () => {
		expect(resolvePermissionMode({ skipPermissions: true, interactive: true })).toEqual({
			mode: 'auto',
		})
	})

	it('asks when there is someone to ask, and does not when there is not', () => {
		// `prompt` without a terminal would silently become `auto` anyway;
		// resolving it as `auto` makes the resolved mode honest in a log.
		expect(resolvePermissionMode({ interactive: true })).toEqual({ mode: 'prompt' })
		expect(resolvePermissionMode({ interactive: false })).toEqual({ mode: 'auto' })
	})

	it('exposes exactly the modes it accepts', () => {
		expect(PERMISSION_MODES.every(isPermissionMode)).toBe(true)
		expect(isPermissionMode('trusted')).toBe(false)
	})
})

describe('a mode decides only what no rule decided', () => {
	function gate(config: Parameters<typeof compilePermissions>[0]) {
		const { rules } = compilePermissions(config)
		return new VerificationGate(
			{
				enabled: true,
				rules: [...rules],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			getRootLogger(),
		)
	}

	it('a denied call never reaches the mode at all', async () => {
		// THE precedence test. `deny` is settled by the gate, so no mode — not
		// even the one spelled --yolo — is ever consulted about it. If this ever
		// fails, a flag has become able to lift a prohibition someone wrote down.
		const decision = gate({ bash: 'deny' }).evaluate({
			toolName: 'bash',
			toolInput: { command: 'rm -rf /tmp/x' },
			toolDef: undefined,
		})

		expect(decision.decision).toBe('deny')
	})

	it('an allowed call never reaches the mode either', () => {
		const decision = gate({ bash: { 'git status*': 'allow' } }).evaluate({
			toolName: 'bash',
			toolInput: { command: 'git status' },
			toolDef: undefined,
		})

		expect(decision.decision).toBe('allow')
	})
})

describe('what each mode does with an undecided call', () => {
	const destructive = [
		{ id: '1', name: 'write', input: { path: 'a.txt' }, isDestructive: true },
	] as never

	it('auto approves it', async () => {
		const handler = makeResumeHandler({ all: false }, undefined, 'auto')

		const decision = await handler({ type: 'tool_review', toolCalls: destructive } as never)

		expect(decision).toEqual({ action: 'approve_tools' })
	})

	it('strict refuses it, and says asking again will not help', async () => {
		// The mode that did not exist: an unattended run could only be `auto`, so
		// a CI job either trusted the agent with everything or could not use it.
		const handler = makeResumeHandler({ all: false }, undefined, 'strict')

		const decision = (await handler({
			type: 'tool_review',
			toolCalls: destructive,
		} as never)) as { action: string; feedback: string }

		expect(decision.action).toBe('reject_tools')
		expect(decision.feedback).toContain('Asking again will not change it')
	})

	it('prompt asks the human, and honours the answer', async () => {
		let asked = false
		const handler = makeResumeHandler(
			{ all: false },
			async () => {
				asked = true
				return { kind: 'reject', feedback: 'not that one' }
			},
			'prompt',
		)

		const decision = (await handler({
			type: 'tool_review',
			toolCalls: destructive,
		} as never)) as { action: string; feedback: string }

		expect(asked).toBe(true)
		expect(decision.action).toBe('reject_tools')
		expect(decision.feedback).toBe('not that one')
	})

	it('read-only batches run under every mode, including strict', async () => {
		// `strict` refuses what needs asking, and a read never needed asking.
		// Refusing reads would make the mode unusable rather than strict.
		const readOnly = [{ id: '1', name: 'read', input: {}, isDestructive: false }] as never
		const handler = makeResumeHandler({ all: false }, undefined, 'strict')

		expect(await handler({ type: 'tool_review', toolCalls: readOnly } as never)).toEqual({
			action: 'approve_tools',
		})
	})
})

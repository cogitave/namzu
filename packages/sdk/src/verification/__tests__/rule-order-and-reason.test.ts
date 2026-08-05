import { describe, expect, it } from 'vitest'

import type { ToolDefinition } from '../../types/tool/index.js'
import type { VerificationGateConfig } from '../../types/verification/index.js'
import { getRootLogger } from '../../utils/logger.js'
import { VerificationGate, describeRule } from '../gate.js'

/**
 * Two things an operator has to be able to trust about a policy gate: that a
 * rule they wrote is consulted, and that a refusal says enough to act on.
 *
 * Neither held. `allowReadOnlyTools` was expanded into a rule AHEAD of the
 * operator's own, and the gate stops at the first match — so "prompt me before
 * every read" was not rejected, not warned about, just never reached. And a
 * denial arrived as the rule's TYPE NAME, which tells a model that a rule
 * matched and nothing whatever about what it said.
 */

function gate(config: Partial<VerificationGateConfig>): VerificationGate {
	return new VerificationGate(
		{
			enabled: true,
			rules: [],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
			...config,
		} as VerificationGateConfig,
		getRootLogger(),
	)
}

/** Only the fields the gate reads. */
function toolDef(name: string, readOnly: boolean): ToolDefinition {
	return { name, isReadOnly: () => readOnly } as unknown as ToolDefinition
}

describe('an operator rule outranks the read-only convenience', () => {
	it('lets a rule make a read-only tool prompt', () => {
		// The case that was silently unreachable: `read` observes only, the
		// convenience is on, and the operator has asked to be consulted anyway.
		const result = gate({
			allowReadOnlyTools: true,
			rules: [{ type: 'deny_by_name', toolNames: ['read'] }],
		}).evaluate({
			toolName: 'read',
			toolInput: { path: 'notes.txt' },
			toolDef: toolDef('read', true),
		})

		expect(result.decision, 'the operator rule was never consulted').toBe('deny')
	})

	it('still allows a read-only tool nobody wrote a rule about', () => {
		// The convenience keeps doing its job as a DEFAULT, which is what it
		// always was in substance.
		const result = gate({
			allowReadOnlyTools: true,
			rules: [{ type: 'deny_by_name', toolNames: ['write'] }],
		}).evaluate({
			toolName: 'grep',
			toolInput: { pattern: 'x' },
			toolDef: toolDef('grep', true),
		})

		expect(result.decision).toBe('allow')
	})
})

describe('the safety floor still outranks everything', () => {
	it('refuses a dangerous pattern even when a rule would allow the tool', () => {
		// The denial goes first and stays there. An operator rule must not be
		// able to open what it closes.
		const result = gate({
			denyDangerousPatterns: true,
			rules: [{ type: 'allow_by_name', toolNames: ['bash'] }],
		}).evaluate({
			toolName: 'bash',
			toolInput: { command: 'rm -rf /' },
			toolDef: toolDef('bash', false),
		})

		expect(result.decision).toBe('deny')
	})
})

describe('a refusal says what the rule said', () => {
	it('names the pattern rather than the rule type', () => {
		// "Matched rule: custom_pattern" tells a model a rule matched and
		// nothing about it, so it rewords the same call and tries again. The
		// pattern is what makes the retry visibly pointless.
		const reason = describeRule({
			type: 'custom_pattern',
			pattern: 'git push*',
			target: 'args',
			decision: 'deny',
		})

		expect(reason).toContain('git push*')
		expect(reason).toContain('denied')
		expect(reason).not.toContain('custom_pattern')
	})

	it('says a by-name denial is about the tool, not the input', () => {
		// The distinction that decides the next move: reworded arguments will
		// not help, so the model should stop rather than iterate.
		const reason = describeRule({ type: 'deny_by_name', toolNames: ['bash', 'write'] })

		expect(reason).toContain('bash')
		expect(reason).toContain('a different input will not change it')
	})

	it('says a dangerous-pattern refusal is not worth rewording', () => {
		expect(describeRule({ type: 'deny_dangerous_patterns' })).toContain('will not help')
	})

	it('reaches the model through the gate result, not just the helper', () => {
		const result = gate({ rules: [{ type: 'deny_by_name', toolNames: ['bash'] }] }).evaluate({
			toolName: 'bash',
			toolInput: { command: 'ls' },
			toolDef: toolDef('bash', false),
		})

		expect(result.reason).toContain('bash')
		expect(result.reason).not.toMatch(/^Matched rule:/)
	})
})

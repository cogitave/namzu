import { describe, expect, it } from 'vitest'

import type { AuthorizationGateConfig, AuthorizationRule } from '../../types/authorization/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { AuthorizationGate } from '../gate.js'

/**
 * Every pattern rule an operator could write was one of two wrong things.
 *
 * `custom_pattern` carries no tool scope, so a rule written about `bash`
 * decided `edit` calls as well. And `target: 'args'` tests
 * `JSON.stringify(toolInput)`, so the subject is the JSON TEXT of the whole
 * argument object — meaning the natural, anchored thing to write
 * (`^git push.*$`) can never match, and the rule silently decides nothing.
 * Pinning the tool cost the anchor; anchoring cost the tool scope.
 */

function gate(rules: AuthorizationGateConfig['rules']): AuthorizationGate {
	return new AuthorizationGate(
		{
			enabled: true,
			rules,
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		} as AuthorizationGateConfig,
		NOOP_LOGGER,
	)
}

/** Only the fields the gate reads. */
function toolDef(name: string): ToolDefinition {
	return { name, isReadOnly: () => false } as unknown as ToolDefinition
}

const PUSH_RULE: AuthorizationRule = {
	type: 'argument_pattern',
	toolNames: ['bash'],
	argument: 'command',
	pattern: '^git push',
	decision: 'deny',
}

function evaluate(
	rules: AuthorizationGateConfig['rules'],
	toolName: string,
	toolInput: unknown,
): ReturnType<AuthorizationGate['evaluate']> {
	return gate(rules).evaluate({ toolName, toolInput, toolDef: toolDef(toolName) })
}

describe('a rule can name one tool and one argument at once', () => {
	it('denies the call it was written about', () => {
		const result = evaluate([PUSH_RULE], 'bash', { command: 'git push origin main' })
		expect(result.decision).toBe('deny')
	})

	it('anchors against the value, which is what the old rule could not do', () => {
		// The whole defect in one assertion: this same pattern under
		// `custom_pattern` with `target: 'args'` is tested against
		// `{"command":"git push origin main"}`, where `^git push` cannot match
		// because the string does not start there.
		const viaOldRule = evaluate(
			[{ type: 'custom_pattern', pattern: '^git push', target: 'args', decision: 'deny' }],
			'bash',
			{ command: 'git push origin main' },
		)
		expect(viaOldRule.decision, 'the old rule silently decided nothing').not.toBe('deny')

		expect(evaluate([PUSH_RULE], 'bash', { command: 'git push origin main' }).decision).toBe('deny')
	})

	it('leaves a different tool alone', () => {
		// The other half: a rule about `bash` used to decide `edit` too,
		// because the pattern was matched against a serialisation that has no
		// idea which tool produced it.
		const result = evaluate([PUSH_RULE], 'edit', { command: 'git push origin main' })
		expect(result.decision).not.toBe('deny')
	})

	it('leaves a different argument alone', () => {
		const result = evaluate([PUSH_RULE], 'bash', { description: 'git push origin main' })
		expect(result.decision).not.toBe('deny')
	})

	it('says which argument decided, so a model knows whether to reword', () => {
		const result = evaluate([PUSH_RULE], 'bash', { command: 'git push origin main' })

		expect(result.reason).toContain('command')
		expect(result.reason).toContain('^git push')
		expect(result.reason).toContain('bash')
	})
})

describe('what it deliberately does not decide', () => {
	it('decides nothing when the argument is absent', () => {
		const result = evaluate([PUSH_RULE], 'bash', {})
		expect(result.decision).not.toBe('deny')
	})

	it('decides nothing about a structured argument', () => {
		// No string a pattern could match says anything true about an object,
		// and serialising it to try would put this rule back where
		// `custom_pattern` already is. An operator who needs to refuse a tool
		// over the SHAPE of its input wants deny_by_name.
		const rule: AuthorizationRule = { ...PUSH_RULE, argument: 'env', pattern: 'PROD' }
		const result = evaluate([rule], 'bash', { env: { NODE_ENV: 'PROD' } })

		expect(result.decision).not.toBe('deny')
	})

	it('reads a number or a boolean rather than skipping it', () => {
		// These render unambiguously, so skipping them would be a fail-open
		// with no upside: a rule about a numeric argument is a rule someone
		// can reasonably write.
		const rule: AuthorizationRule = {
			type: 'argument_pattern',
			toolNames: ['sleep'],
			argument: 'seconds',
			pattern: '^[0-9]{4,}$',
			decision: 'deny',
		}

		expect(evaluate([rule], 'sleep', { seconds: 86400 }).decision).toBe('deny')
		expect(evaluate([rule], 'sleep', { seconds: 5 }).decision).not.toBe('deny')
	})
})

describe('a rule that cannot be compiled decides nothing at all', () => {
	it('does not widen into a rule about the whole tool', () => {
		// The failure this forbids: a typo'd regex turning "deny bash when its
		// command matches X" into "deny bash" — a far larger authorization than
		// anybody wrote, granted by a mistake nobody would notice.
		//
		// What actually secures it is the missing-pattern check at the top of
		// `evaluateRule`, which returns before the tool name is consulted. The
		// gate's construction order (compile first, only then record the names)
		// is defence in depth and NOT the mechanism: reversing those two lines
		// fails nothing, which was measured rather than assumed. So this test
		// pins the OUTCOME and the comment in the gate says which line to keep.
		const broken: AuthorizationRule = { ...PUSH_RULE, pattern: '([unclosed' }
		const result = evaluate([broken], 'bash', { command: 'ls' })

		expect(result.decision).not.toBe('deny')
	})

	it('is secured by the pattern check, not by the construction order', () => {
		// The honest version of the mutation: remove the check that actually
		// holds and this fails. A rule whose pattern never compiled has no
		// pattern to test, so it must decide nothing even for a tool it names.
		const broken: AuthorizationRule = { ...PUSH_RULE, pattern: '([unclosed' }

		expect(evaluate([broken], 'bash', { command: 'git push origin main' }).decision).not.toBe(
			'deny',
		)
	})
})

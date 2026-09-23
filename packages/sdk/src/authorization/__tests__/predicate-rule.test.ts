import { describe, expect, it } from 'vitest'

import type {
	AuthorizationGateConfig,
	AuthorizationPredicateCall,
	AuthorizationRule,
} from '../../types/authorization/index.js'
import { AuthorizationGateConfigSchema } from '../../types/authorization/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { AuthorizationGate, describeRule } from '../gate.js'
import { evaluateRule } from '../rules.js'

/**
 * A `predicate` rule is a decision the host computes in code, in its place in
 * the rule list. It exists for rules about what a command line does, which a
 * pattern over the line's text can only approximate.
 */

function gate(rules: AuthorizationRule[]): AuthorizationGate {
	return new AuthorizationGate(
		{
			enabled: true,
			rules,
			allowReadOnlyTools: false,
			denyDangerousPatterns: true,
			logDecisions: false,
		} as AuthorizationGateConfig,
		NOOP_LOGGER,
	)
}

const predicate = (
	decide: (call: AuthorizationPredicateCall) => 'allow' | 'deny' | 'review' | null,
): AuthorizationRule => ({
	type: 'predicate',
	description: 'the host’s own rule',
	decide,
})

describe('a predicate rule', () => {
	it('decides in its place: after the dangerous-command floor, before later rules', () => {
		const g = gate([
			predicate((call) => (call.toolName === 'bash' ? 'deny' : null)),
			{ type: 'allow_by_name', toolNames: ['bash', 'read'] },
		])
		const bash = g.evaluate({
			toolName: 'bash',
			toolInput: { command: 'ls' },
			toolDef: undefined,
		})
		expect(bash.decision).toBe('deny')
		expect(bash.reason).toBe('the host’s own rule')
		// `null` hands the call on.
		expect(
			g.evaluate({
				toolName: 'read',
				toolInput: { path: 'a' },
				toolDef: undefined,
			}).decision,
		).toBe('allow')
		// The floor still outranks it.
		const allowAll = gate([predicate(() => 'allow')])
		expect(
			allowAll.evaluate({
				toolName: 'bash',
				toolInput: { command: 'rm -rf /' },
				toolDef: undefined,
			}).decision,
		).toBe('deny')
	})

	it('reads a throw as deny: a rule that could not decide has not approved', () => {
		const g = gate([
			predicate(() => {
				throw new Error('boom')
			}),
			{ type: 'allow_by_name', toolNames: ['bash'] },
		])
		expect(
			g.evaluate({
				toolName: 'bash',
				toolInput: { command: 'ls' },
				toolDef: undefined,
			}).decision,
		).toBe('deny')
	})

	it('is told the dialect the command line runs in, and `sh` when the caller did not say', () => {
		const seen: string[] = []
		const g = gate([
			predicate((call) => {
				seen.push(call.commandDialect)
				return null
			}),
		])
		g.evaluate({ toolName: 'bash', toolInput: {}, toolDef: undefined })
		g.evaluate({
			toolName: 'bash',
			toolInput: {},
			toolDef: undefined,
			commandDialect: 'bash',
		})
		expect(seen).toEqual(['sh', 'bash'])
		const rule = predicate((call) => (call.commandDialect === 'bash' ? 'deny' : null))
		expect(evaluateRule(rule, 'bash', {}, undefined, undefined, undefined, {})).toBeNull()
		expect(
			evaluateRule(rule, 'bash', {}, undefined, undefined, undefined, {
				commandDialect: 'bash',
			}),
		).toBe('deny')
	})

	it('names itself in the refusal', () => {
		expect(describeRule(predicate(() => null))).toBe('the host’s own rule')
	})

	it('needs a description and a function', () => {
		const parse = (rule: unknown) =>
			AuthorizationGateConfigSchema.safeParse({ enabled: true, rules: [rule] }).success
		expect(parse({ type: 'predicate', description: 'x', decide: () => null })).toBe(true)
		expect(parse({ type: 'predicate', description: '', decide: () => null })).toBe(false)
		expect(parse({ type: 'predicate', description: 'x', decide: 'deny' })).toBe(false)
		expect(parse({ type: 'predicate', description: 'x' })).toBe(false)
	})

	it('keeps its function through the gate’s own parse', () => {
		// zod strips what a schema does not name; a stripped `decide` would
		// leave a rule that can never be called.
		const parsed = AuthorizationGateConfigSchema.parse({
			enabled: true,
			rules: [predicate(() => 'deny')],
		})
		const rule = parsed.rules[0]
		expect(rule?.type === 'predicate' && typeof rule.decide).toBe('function')
	})
})

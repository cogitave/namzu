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

	it('says what in the call matched when it has a describe', () => {
		const rule: AuthorizationRule = {
			type: 'predicate',
			description: 'the host’s own rule',
			decide: (call) => (call.toolName === 'bash' ? 'deny' : null),
			describe: (call) =>
				`\`${(call.toolInput as { command: string }).command}\` in ${call.commandDialect}`,
		}
		const g = gate([rule])
		const result = g.evaluate({
			toolName: 'bash',
			toolInput: { command: 'ls' },
			toolDef: undefined,
			commandDialect: 'bash',
		})
		expect(result.decision).toBe('deny')
		expect(result.reason).toBe('`ls` in bash')
		// The dialect `decide` was told when the caller said nothing.
		expect(
			g.evaluate({ toolName: 'bash', toolInput: { command: 'ls' }, toolDef: undefined }).reason,
		).toBe('`ls` in sh')
		expect(describeRule(rule)).toBe('the host’s own rule')
	})

	it('falls back to its description when describe has nothing to say or throws', () => {
		const withDescribe = (describe: () => string | null): AuthorizationRule => ({
			type: 'predicate',
			description: 'the host’s own rule',
			decide: () => 'deny',
			describe,
		})
		const call = { toolName: 'bash', toolInput: {}, toolDef: undefined }
		expect(gate([withDescribe(() => null)]).evaluate(call).reason).toBe('the host’s own rule')
		expect(gate([withDescribe(() => '')]).evaluate(call).reason).toBe('the host’s own rule')
		const thrown = gate([
			withDescribe(() => {
				throw new Error('boom')
			}),
		]).evaluate(call)
		expect(thrown.decision).toBe('deny')
		expect(thrown.reason).toBe('the host’s own rule')
	})

	it('needs a description and a function', () => {
		const parse = (rule: unknown) =>
			AuthorizationGateConfigSchema.safeParse({ enabled: true, rules: [rule] }).success
		expect(parse({ type: 'predicate', description: 'x', decide: () => null })).toBe(true)
		expect(parse({ type: 'predicate', description: '', decide: () => null })).toBe(false)
		expect(parse({ type: 'predicate', description: 'x', decide: 'deny' })).toBe(false)
		expect(parse({ type: 'predicate', description: 'x' })).toBe(false)
		expect(
			parse({ type: 'predicate', description: 'x', decide: () => null, describe: 'why' }),
		).toBe(false)
	})

	it('keeps its functions through the gate’s own parse', () => {
		// zod strips what a schema does not name; a stripped `decide` would
		// leave a rule that can never be called, a stripped `describe` a
		// refusal that no longer says what matched.
		const parsed = AuthorizationGateConfigSchema.parse({
			enabled: true,
			rules: [{ ...predicate(() => 'deny'), describe: () => 'why' }],
		})
		const rule = parsed.rules[0]
		expect(rule?.type === 'predicate' && typeof rule.decide).toBe('function')
		expect(rule?.type === 'predicate' && typeof rule.describe).toBe('function')
	})
})

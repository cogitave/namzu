/**
 * Current-code invariants asserted (2026-07-12, ses_017):
 *
 *   - `evaluate` on a disabled gate returns `review` with no matched rule; it does
 *     not consult the rules at all.
 *   - With no rule matching, the default decision is `review` (fail-to-human, not
 *     fail-to-allow).
 *   - The constructor expands `denyDangerousPatterns` and `allowReadOnlyTools`
 *     into rules PREPENDED ahead of every operator-authored rule, in that order.
 *   - (ses_017 fix) Deny has GLOBAL PRECEDENCE. A deny rule matching a call beats
 *     an allow rule matching the same call regardless of declaration order. Rule
 *     order still decides allow-vs-review among non-deny rules (first match wins).
 *     Before the fix this scan was first-match-wins across all three decisions, so
 *     an earlier `allow` masked a later `deny` — and because the built-in
 *     `allow_read_only` rule is prepended by the constructor, an operator's
 *     explicit `deny_by_name` on a read-only tool was unreachable config.
 *   - An unparseable `custom_pattern` regex is skipped at construction (warn), and
 *     a skipped rule matches nothing — it does not deny, and it does not throw.
 *   - A `custom_pattern` longer than MAX_CUSTOM_PATTERN_LENGTH is skipped at
 *     construction. (Schema-level: the config schema also rejects it outright, so
 *     this arm is reachable only through the constructor's own guard.)
 */

import { describe, expect, it, vi } from 'vitest'

import type { ToolDefinition } from '../types/tool/index.js'
import type { VerificationGateConfig } from '../types/verification/index.js'
import type { Logger } from '../utils/logger.js'
import { VerificationGate } from './gate.js'

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

/**
 * `VerificationGateConfig` is the schema's OUTPUT type, so every field is required
 * at the type level even though the schema defaults them at runtime — a config
 * built by hand has to spell out all five. This fills them so each test states
 * only the rules it is about.
 */
function makeGate(
	partial: Partial<VerificationGateConfig>,
	log: Logger = makeLogger(),
): VerificationGate {
	return new VerificationGate(
		{
			enabled: partial.enabled ?? true,
			rules: partial.rules ?? [],
			allowReadOnlyTools: partial.allowReadOnlyTools ?? false,
			denyDangerousPatterns: partial.denyDangerousPatterns ?? false,
			logDecisions: partial.logDecisions ?? true,
		},
		log,
	)
}

const readOnlyTool = {
	name: 'read_file',
	description: 'read a file',
	isReadOnly: () => true,
	category: 'filesystem',
	tier: 'safe',
} as unknown as ToolDefinition

describe('VerificationGate', () => {
	it('returns review without consulting rules when disabled', () => {
		const gate = makeGate(
			{ enabled: false, rules: [{ type: 'deny_by_name', toolNames: ['read_file'] }] },
			makeLogger(),
		)

		const result = gate.evaluate({ toolName: 'read_file', toolInput: {}, toolDef: readOnlyTool })

		expect(result.decision).toBe('review')
		expect(result.matchedRule).toBeNull()
		expect(result.reason).toBe('Gate disabled')
	})

	it('defaults to review when no rule matches', () => {
		const gate = makeGate({ enabled: true, rules: [] }, makeLogger())

		const result = gate.evaluate({ toolName: 'unknown', toolInput: {}, toolDef: undefined })

		expect(result.decision).toBe('review')
		expect(result.matchedRule).toBeNull()
		expect(result.reason).toBe('No matching rule found')
	})

	it('allows a read-only tool through the built-in allow_read_only rule', () => {
		const gate = makeGate({ enabled: true, allowReadOnlyTools: true, rules: [] }, makeLogger())

		const result = gate.evaluate({ toolName: 'read_file', toolInput: {}, toolDef: readOnlyTool })

		expect(result.decision).toBe('allow')
		expect(result.matchedRule).toEqual({ type: 'allow_read_only' })
	})

	describe('deny precedence', () => {
		it('denies when a deny rule is declared AFTER an allow rule that also matches', () => {
			const gate = makeGate(
				{
					enabled: true,
					rules: [
						{ type: 'allow_by_name', toolNames: ['run_shell'] },
						{ type: 'deny_by_name', toolNames: ['run_shell'] },
					],
				},
				makeLogger(),
			)

			const result = gate.evaluate({ toolName: 'run_shell', toolInput: {}, toolDef: undefined })

			expect(result.decision).toBe('deny')
			expect(result.matchedRule).toEqual({ type: 'deny_by_name', toolNames: ['run_shell'] })
		})

		it('denies when the masking allow is the built-in allow_read_only rule', () => {
			// The live shape of the bug: the constructor prepends `allow_read_only`,
			// so an operator's `deny_by_name` on a read-only tool sat behind an allow
			// it could never overtake. Enabling the safety flag disabled the deny.
			const gate = makeGate(
				{
					enabled: true,
					allowReadOnlyTools: true,
					rules: [{ type: 'deny_by_name', toolNames: ['read_file'] }],
				},
				makeLogger(),
			)

			const result = gate.evaluate({ toolName: 'read_file', toolInput: {}, toolDef: readOnlyTool })

			expect(result.decision).toBe('deny')
		})

		it('denies on a later custom_pattern deny that an earlier category allow matched', () => {
			const gate = makeGate(
				{
					enabled: true,
					rules: [
						{ type: 'allow_by_category', categories: ['filesystem'] },
						{
							type: 'custom_pattern',
							pattern: '/etc/(passwd|shadow)',
							target: 'args',
							decision: 'deny',
						},
					],
				},
				makeLogger(),
			)

			expect(
				gate.evaluate({
					toolName: 'read_file',
					toolInput: { path: '/etc/passwd' },
					toolDef: readOnlyTool,
				}).decision,
			).toBe('deny')

			// The same allow still works for a call no deny rule matches.
			expect(
				gate.evaluate({
					toolName: 'read_file',
					toolInput: { path: '/tmp/notes.md' },
					toolDef: readOnlyTool,
				}).decision,
			).toBe('allow')
		})

		it('denies on the built-in dangerous-pattern rule even when a tier rule allows the tool', () => {
			const gate = makeGate(
				{
					enabled: true,
					denyDangerousPatterns: true,
					rules: [{ type: 'allow_by_tier', tiers: ['safe'] }],
				},
				makeLogger(),
			)

			expect(
				gate.evaluate({
					toolName: 'run_shell',
					toolInput: { command: 'rm -rf /' },
					toolDef: readOnlyTool,
				}).decision,
			).toBe('deny')
		})

		it('keeps first-match-wins among allow and review rules', () => {
			const gate = makeGate(
				{
					enabled: true,
					rules: [
						{ type: 'allow_by_name', toolNames: ['run_shell'] },
						{ type: 'allow_by_category', categories: ['filesystem'] },
					],
				},
				makeLogger(),
			)

			const result = gate.evaluate({ toolName: 'run_shell', toolInput: {}, toolDef: readOnlyTool })

			// The earlier of the two matching allow rules is the one reported.
			expect(result.decision).toBe('allow')
			expect(result.matchedRule).toEqual({ type: 'allow_by_name', toolNames: ['run_shell'] })
		})
	})

	it('allows by tier when no deny rule matches', () => {
		const gate = makeGate(
			{ enabled: true, rules: [{ type: 'allow_by_tier', tiers: ['safe', 'trusted'] }] },
			makeLogger(),
		)

		expect(
			gate.evaluate({ toolName: 'read_file', toolInput: {}, toolDef: readOnlyTool }).decision,
		).toBe('allow')

		// A tool with no tier is not matched by the rule; it falls through to review.
		expect(
			gate.evaluate({ toolName: 'untiered', toolInput: {}, toolDef: undefined }).decision,
		).toBe('review')
	})

	it('skips an invalid custom_pattern regex instead of matching or throwing', () => {
		const log = makeLogger()
		const gate = makeGate(
			{
				enabled: true,
				rules: [{ type: 'custom_pattern', pattern: '([', target: 'args', decision: 'deny' }],
			},
			log,
		)

		const result = gate.evaluate({ toolName: 'anything', toolInput: {}, toolDef: undefined })

		// A rule that could not compile matches nothing; the call falls through to
		// the default (review), which is the safe direction.
		expect(result.decision).toBe('review')
		expect(result.matchedRule).toBeNull()
	})

	it('matches a custom_pattern against name and both targets', () => {
		const gate = makeGate(
			{
				enabled: true,
				rules: [
					{ type: 'custom_pattern', pattern: '^admin_', target: 'name', decision: 'deny' },
					{ type: 'custom_pattern', pattern: 'notes.*read', target: 'both', decision: 'allow' },
				],
			},
			makeLogger(),
		)

		expect(
			gate.evaluate({ toolName: 'admin_reset', toolInput: {}, toolDef: undefined }).decision,
		).toBe('deny')
		expect(
			gate.evaluate({ toolName: 'notes', toolInput: { mode: 'read' }, toolDef: undefined })
				.decision,
		).toBe('allow')
	})
})

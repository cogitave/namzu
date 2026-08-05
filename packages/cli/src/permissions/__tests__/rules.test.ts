/**
 * The rule compiler.
 *
 * The load-bearing case is the LAST one: a tool nobody wrote a rule for must
 * still be asked about. A declarative permission model that quietly widened the
 * default would be a security downgrade wearing a feature's clothes, and it
 * would look exactly like this change from the outside.
 */

import { VerificationGate, configureLogger, getRootLogger } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	bySpecificity,
	compilePermissions,
	matchesPattern,
	patternToRegExpSource,
} from '../rules.js'

describe('pattern matching', () => {
	it('matches a literal command exactly', () => {
		expect(matchesPattern('git status', 'git status')).toBe(true)
		expect(matchesPattern('git statuses', 'git status')).toBe(false)
	})

	it('lets * stand for any run of characters and ? for one', () => {
		expect(matchesPattern('git push --force', 'git push*')).toBe(true)
		expect(matchesPattern('cat a.ts', 'cat ?.ts')).toBe(true)
		expect(matchesPattern('cat ab.ts', 'cat ?.ts')).toBe(false)
	})

	it('matches the bare command for a trailing " *"', () => {
		// `git push *` is the obvious way to write "any git push". Without this
		// the rule silently misses the exact invocation it was written for.
		expect(matchesPattern('git push', 'git push *')).toBe(true)
		expect(matchesPattern('git push origin main', 'git push *')).toBe(true)
	})

	it('treats a backslash path as its forward-slash self, both sides', () => {
		// One rule has to work on every platform; an operator should not have to
		// write the same path twice.
		expect(matchesPattern('src\\index.ts', 'src/*.ts')).toBe(true)
		expect(matchesPattern('src/index.ts', 'src\\*.ts')).toBe(true)
	})

	it('does not let a pattern character smuggle in a regex', () => {
		// `.` is a literal dot, not "any character", or a rule meant to allow
		// `a.ts` would also allow `axts`.
		expect(matchesPattern('axts', 'a.ts')).toBe(false)
		expect(matchesPattern('a.ts', 'a.ts')).toBe(true)
		expect(patternToRegExpSource('a+b')).toBe('^a\\+b$')
	})

	it('anchors, so a pattern is not a substring search', () => {
		expect(matchesPattern('sudo git status', 'git status')).toBe(false)
	})
})

describe('specificity ordering', () => {
	// The kernel evaluates first-match-wins, so order decides meaning: a bare
	// `*` sorted first would make every rule after it dead config.
	it('puts a bare star last', () => {
		expect(['*', 'git push*', 'git status'].sort(bySpecificity)).toEqual([
			'git status',
			'git push*',
			'*',
		])
	})

	it('puts a longer literal prefix first', () => {
		expect(['git*', 'git push*'].sort(bySpecificity)).toEqual(['git push*', 'git*'])
	})

	it('is stable for two patterns of equal specificity', () => {
		expect(['b*', 'a*'].sort(bySpecificity)).toEqual(['a*', 'b*'])
	})
})

describe('compiling a permissions table', () => {
	it('turns a bare allow and deny into by-name rules', () => {
		const { rules } = compilePermissions({ read: 'allow', bash: 'deny' })

		expect(rules).toEqual([
			{ type: 'allow_by_name', toolNames: ['read'] },
			{ type: 'deny_by_name', toolNames: ['bash'] },
		])
	})

	it('emits pattern rules most-specific-first', () => {
		const { rules } = compilePermissions({ bash: { '*': 'deny', 'git status*': 'allow' } })

		expect(rules.map((r) => ('decision' in r ? r.decision : r.type))).toEqual(['allow', 'deny'])
	})

	it('emits nothing for ask, because the gate already asks by default', () => {
		// If "ask" emitted a rule it would have to mean something different from
		// the absence of a rule, and it does not.
		const { rules } = compilePermissions({ edit: 'ask', bash: { 'rm *': 'ask' } })

		expect(rules).toEqual([])
	})

	it('reports a bad effect instead of dropping it in silence', () => {
		// A permission someone believes is in force and which was quietly
		// discarded is the worst outcome here — worse than refusing to start.
		const { rules, diagnostics } = compilePermissions({
			bash: { 'git push*': 'maybe' } as never,
		})

		expect(rules).toEqual([])
		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.tool).toBe('bash')
		expect(diagnostics[0]?.pattern).toBe('git push*')
	})

	it('keeps the other rules when one line is unreadable', () => {
		const { rules, diagnostics } = compilePermissions({
			read: 'allow',
			bash: 7 as never,
			glob: 'allow',
		})

		expect(rules).toHaveLength(2)
		expect(diagnostics).toHaveLength(1)
	})

	it('a tool nobody wrote a rule for produces no rule, so the gate asks', () => {
		// THE case. The kernel's fallback for an unmatched call is `review`, so
		// emitting nothing is what makes an unconfigured or newly bridged tool
		// prompt. There is deliberately no way to spell "allow by omission":
		// widening the default has to be something an operator typed.
		const { rules } = compilePermissions({ read: 'allow' })

		expect(rules.some((r) => 'toolNames' in r && r.toolNames.includes('some_new_tool'))).toBe(false)
		expect(rules).toHaveLength(1)
	})

	it('is empty for absent config, which is the same as asking about everything', () => {
		expect(compilePermissions(undefined)).toEqual({ rules: [], diagnostics: [] })
	})
})

configureLogger({ level: 'silent' })

describe('the rules actually decide a real call', () => {
	// The compiler tests above assert the SHAPE of the emitted rules. Shape is
	// not behaviour: the first version of this compiler emitted `target: 'args'`
	// with an anchored pattern, which matches `JSON.stringify(input)` — so
	// `^git push.*$` could never match `{"command":"git push origin main"}` and
	// every pattern rule decided nothing at all. It looked correct in every
	// shape assertion. These drive the kernel's own gate instead.
	function decide(config: Parameters<typeof compilePermissions>[0], tool: string, input: unknown) {
		const { rules } = compilePermissions(config)
		const gate = new VerificationGate(
			{
				enabled: true,
				rules: [...rules],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			getRootLogger(),
		)
		return gate.evaluate({ toolName: tool, toolInput: input, toolDef: undefined }).decision
	}

	it('allows the command an operator allowed', () => {
		expect(decide({ bash: { 'git status*': 'allow' } }, 'bash', { command: 'git status' })).toBe(
			'allow',
		)
	})

	it('denies the command an operator denied', () => {
		expect(
			decide({ bash: { 'git push*': 'deny' } }, 'bash', { command: 'git push origin main' }),
		).toBe('deny')
	})

	it('does not let one tool_s rule decide another tool_s call', () => {
		// A rule written under `bash` must not decide an `edit` call whose
		// arguments happen to contain the same text. The kernel_s pattern rules
		// carry no tool scope, so this is the CLI_s job and it is easy to lose.
		expect(
			decide({ bash: { 'git push*': 'deny' } }, 'edit', { content: 'run git push to deploy' }),
		).toBe('review')
	})

	it('asks about a tool nobody wrote a rule for', () => {
		// The load-bearing case, driven end to end rather than inferred.
		expect(decide({ read: 'allow' }, 'some_new_bridged_tool', { x: 1 })).toBe('review')
	})

	it('prefers the specific rule over the catch-all, whatever the config order', () => {
		const config = { bash: { '*': 'allow', 'git push*': 'deny' } } as const
		expect(decide(config, 'bash', { command: 'git push --force' })).toBe('deny')
		expect(decide(config, 'bash', { command: 'ls' })).toBe('allow')
	})
})

/**
 * The "don't ask again" answers, as pure behaviour: which call can have one
 * remembered, and how the kernel's own gate consults them, behind the
 * operator's rules.
 */

import {
	AuthorizationGate,
	type AuthorizationRule,
	NOOP_LOGGER,
	builtinCommandArguments,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { allowFor, allowsForBatch, createSessionAllows, describeAllows } from '../session-allow.js'

const commands = builtinCommandArguments()

describe('what a call can have remembered', () => {
	const bash = (command: string, extra: object = {}) => ({
		name: 'bash',
		input: { command },
		...extra,
	})

	it('remembers a command, a fetched host and an MCP tool', () => {
		expect(allowFor(bash('npm test'), commands)).toEqual({
			kind: 'prefix',
			tool: 'bash',
			prefix: 'npm test',
		})
		expect(allowFor(bash('ls'), commands)).toEqual({ kind: 'command', tool: 'bash', command: 'ls' })
		expect(
			allowFor({ name: 'web_fetch', input: { url: 'https://example.com/a?b=1' } }, commands),
		).toEqual({ kind: 'host', tool: 'web_fetch', host: 'example.com' })
		expect(allowFor({ name: 'mcp__files__read', input: {} }, commands)).toEqual({
			kind: 'tool',
			tool: 'mcp__files__read',
		})
	})

	it.each([
		['a glob', bash('rm *.log')],
		['a compound line with a glob in one part', bash('npm test && rm *.log')],
		['a redirection', bash('npm test > out.log')],
		['a several-line command', bash('npm test\nnpm run lint')],
		['a substitution', bash('echo $(whoami)')],
		['an escape from the sandbox', bash('curl x', { escalation: { sandboxEscape: true } })],
		[
			'the escape flag itself',
			{ name: 'bash', input: { command: 'ls', dangerously_disable_sandbox: true } },
		],
		[
			'a path outside the roots',
			bash('cat /etc/hosts', { escalation: { outsidePaths: ['/etc/hosts'] } }),
		],
		['a call a rule asked about', bash('npm test', { authorization: { explicitReview: true } })],
		['a call that must always be asked', bash('npm test', { requiresApproval: true })],
		['a destructive command', bash('rm -rf build', { isDestructive: true })],
		['a wildcard host', { name: 'web_fetch', input: { url: 'https://*.example.com/' } }],
		['a tool with no rule form', { name: 'browser', input: { action: 'open' } }],
	])('remembers nothing for %s', (_why, call) => {
		expect(allowFor(call, commands)).toBeUndefined()
	})

	it('offers a batch answer only when every call has one', () => {
		expect(allowsForBatch([bash('npm test'), bash('npm run lint')], commands)).toHaveLength(2)
		expect(allowsForBatch([bash('npm test'), bash('npm test')], commands)).toHaveLength(1)
		expect(
			allowsForBatch([bash('npm test'), { name: 'write', input: { path: 'a' } }], commands),
		).toBeUndefined()
	})

	it('names what it remembers in a few words', () => {
		expect(describeAllows([{ kind: 'command', tool: 'bash', command: 'npm test' }])).toBe(
			'npm test commands',
		)
		expect(describeAllows([{ kind: 'prefix', tool: 'bash', prefix: 'git commit' }])).toBe(
			'git commit * commands',
		)
		expect(
			describeAllows([
				{ kind: 'host', tool: 'web_fetch', host: 'a.dev' },
				{ kind: 'host', tool: 'web_fetch', host: 'b.dev' },
			]),
		).toBe('a.dev and b.dev')
	})
})

describe('the rule the kernel consults', () => {
	const gateWith = (
		operator: readonly AuthorizationRule[],
		store = createSessionAllows(commands),
	) => ({
		store,
		gate: new AuthorizationGate(
			{
				enabled: true,
				rules: [...operator, store.rule],
				allowReadOnlyTools: false,
				denyDangerousPatterns: true,
				logDecisions: false,
			},
			NOOP_LOGGER,
		),
	})
	const call = (command: string, extra: object = {}) => ({
		toolName: 'bash',
		toolInput: { command, ...extra },
		toolDef: undefined,
		commandDialect: 'sh' as const,
	})

	it('allows exactly the command that was remembered, and only after it was', () => {
		const { gate, store } = gateWith([])
		expect(gate.evaluate(call('npm test')).decision).toBe('review')
		store.add([{ kind: 'command', tool: 'bash', command: 'npm test' }])
		expect(gate.evaluate(call('npm test')).decision).toBe('allow')
		expect(gate.evaluate(call('npm test --watch')).decision).toBe('review')
		expect(gate.evaluate(call('npm test; rm x')).decision).toBe('review')
		expect(gate.evaluate(call('npm test', { dangerously_disable_sandbox: true })).decision).toBe(
			'review',
		)
	})

	it('sits behind the operator rules and the dangerous-pattern floor', () => {
		const { gate, store } = gateWith([{ type: 'deny_by_name', toolNames: ['web_fetch'] }])
		store.add([
			{ kind: 'host', tool: 'web_fetch', host: 'example.com' },
			{ kind: 'command', tool: 'bash', command: 'rm -rf /' },
		])
		expect(
			gate.evaluate({
				toolName: 'web_fetch',
				toolInput: { url: 'https://example.com/' },
				toolDef: undefined,
				commandDialect: 'sh',
			}).decision,
		).toBe('deny')
		expect(gate.evaluate(call('rm -rf /')).decision).toBe('deny')
	})
})

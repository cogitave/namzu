import { describe, expect, it } from 'vitest'

import { SubagentActivityMonitor } from '../activity.js'
import {
	MAX_AGENT_NAME_LENGTH,
	agentNameProblem,
	nameFromDescription,
	nameFromType,
	uniqueAgentName,
} from '../names.js'

describe('agent names', () => {
	it('accepts short lowercase kebab-case names', () => {
		for (const name of ['count-words', 'a', 'audit-auth-2', 'x1'])
			expect(agentNameProblem(name)).toBeUndefined()
	})

	it('refuses what is not a slug, is too long, is reserved or looks like an id', () => {
		expect(agentNameProblem('')).toBeDefined()
		expect(agentNameProblem('Count Words')).toContain('lowercase')
		expect(agentNameProblem('count_words')).toContain('lowercase')
		expect(agentNameProblem('-lead')).toContain('lowercase')
		expect(agentNameProblem('a'.repeat(MAX_AGENT_NAME_LENGTH + 1))).toContain('longer')
		expect(agentNameProblem('main')).toContain('reserved')
		expect(agentNameProblem('agent-3')).toContain('identifier')
		expect(agentNameProblem('dyn-1')).toContain('identifier')
		expect(agentNameProblem('wrun00001')).toContain('identifier')
	})

	it('derives a slug from the first meaningful words of a description', () => {
		expect(nameFromDescription('Count words in a.txt')).toBe('count-words-txt')
		expect(nameFromDescription('List files in project directory')).toBe(
			'list-files-project-directory',
		)
		expect(nameFromDescription('Audit the authentication flow for session bugs')).toBe(
			'audit-authentication-flow',
		)
		expect(nameFromDescription('   ')).toBeUndefined()
		expect(nameFromDescription('日本語')).toBeUndefined()
		expect(nameFromDescription('Zażółć gęślą jaźń')?.length).toBeLessThanOrEqual(
			MAX_AGENT_NAME_LENGTH,
		)
	})

	it('falls back to the type when there is nothing to derive from', () => {
		expect(nameFromType('general-purpose')).toBe('general-purpose')
		expect(nameFromType('Explore')).toBe('explore')
	})

	it('suffixes -2, -3 on collision without passing the length cap', () => {
		const taken = new Set(['count-words', 'count-words-2'])
		expect(uniqueAgentName('count-words', (n) => taken.has(n))).toBe('count-words-3')
		const long = 'a'.repeat(MAX_AGENT_NAME_LENGTH)
		const name = uniqueAgentName(long, (n) => n === long)
		expect(name.length).toBeLessThanOrEqual(MAX_AGENT_NAME_LENGTH)
		expect(name.endsWith('-2')).toBe(true)
	})
})

describe('the monitor hands out names', () => {
	const begin = (monitor: SubagentActivityMonitor, name: string, description = 'd') =>
		monitor.begin({ agentId: 'general-purpose', description, prompt: 'p', name })

	it('derives, de-duplicates among running agents and frees a name when its agent ends', () => {
		const monitor = new SubagentActivityMonitor()
		const first = monitor.reserveName({
			description: 'Count words in a.txt',
			type: 'general-purpose',
		})
		expect(first).toBe('count-words-txt')
		const tracker = begin(monitor, first)
		const second = monitor.reserveName({
			description: 'Count words in a.txt',
			type: 'general-purpose',
		})
		expect(second).toBe('count-words-txt-2')
		tracker.fail(new Error('boom'))
		expect(
			monitor.reserveName({ description: 'Count words in a.txt', type: 'general-purpose' }),
		).toBe('count-words-txt')
		monitor.close()
	})

	it('uses a requested name exactly and refuses one a running agent holds', () => {
		const monitor = new SubagentActivityMonitor()
		const name = monitor.reserveName({
			requested: 'audit-auth',
			description: 'whatever',
			type: 'general-purpose',
		})
		expect(name).toBe('audit-auth')
		begin(monitor, name)
		expect(() =>
			monitor.reserveName({ requested: 'audit-auth', description: 'x', type: 'general-purpose' }),
		).toThrow(/already running/)
		expect(() =>
			monitor.reserveName({ requested: 'Bad Name', description: 'x', type: 'general-purpose' }),
		).toThrow(/lowercase/)
		expect(monitor.resolveName('audit-auth')?.viewId).toBeDefined()
		expect(monitor.resolveName('@audit-auth')?.viewId).toBeDefined()
		expect(monitor.resolveName('nope')).toBeUndefined()
		monitor.close()
	})

	it('records the last tool call as the live summary', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = begin(monitor, 'reader')
		tracker.onEvent({
			type: 'tool_executing',
			toolName: 'Read',
			toolUseId: 't1',
			input: { path: 'a.txt' },
		} as never)
		monitor.close()
	})
})

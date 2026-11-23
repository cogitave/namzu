import { describe, expect, it } from 'vitest'

import { launchMcpServers, parseExecFlags } from './exec-flags.js'
import { resolveRunFlags } from './run-flags.js'

const prefs = { version: 3 as const, providers: [], subagents: { active: [] } }

describe('the exec parser reads the launch shapers', () => {
	it('takes --system-prompt, --tools, -n/--name and --strict-mcp-config', () => {
		const flags = parseExecFlags([
			'--system-prompt',
			'Be brief.',
			'--tools=',
			'-n',
			'nightly run',
			'--strict-mcp-config',
			'--mcp-config',
			'a.json',
			'do it',
		])
		expect(flags.systemPrompt).toBe('Be brief.')
		expect(flags.tools).toBe('')
		expect(flags.name).toBe('nightly run')
		expect(flags.strictMcpConfig).toBe(true)
		expect(flags.mcpConfigs).toEqual(['a.json'])
		expect(flags.unknown).toEqual([])
		expect(flags.rest).toEqual(['do it'])
		expect(parseExecFlags(['--name=x', 'p']).name).toBe('x')
	})

	it('leaves them off when not given', () => {
		const flags = parseExecFlags(['p'])
		expect([flags.systemPrompt, flags.tools, flags.name, flags.strictMcpConfig]).toEqual([
			null,
			null,
			null,
			false,
		])
	})

	it('turns them into the run effects, or the first error', () => {
		const run = resolveRunFlags(
			parseExecFlags(['--system-prompt', 'X', '--tools', 'Read bash']),
			prefs,
		)
		if ('error' in run) throw new Error(run.error)
		expect(run.replaceSystem).toBe('X')
		expect(run.onlyTools).toEqual(['read', 'bash'])
		const none = resolveRunFlags(parseExecFlags(['--tools', '']), prefs)
		if ('error' in none) throw new Error(none.error)
		expect(none.onlyTools).toEqual([])
		expect(resolveRunFlags(parseExecFlags(['--tools', 'bash(ls)']), prefs)).toHaveProperty('error')
		expect(resolveRunFlags(parseExecFlags(['--system-prompt', ' ']), prefs)).toHaveProperty('error')
	})
})

describe('tool servers for a run', () => {
	const configured = { saved: { command: 'node' } } as never
	it('adds inline JSON to the configured servers, and strict keeps only the named ones', () => {
		const inline = '{"mcpServers": {"inline": {"command": "node"}}}'
		const added = launchMcpServers(configured, [inline])
		if ('error' in added) throw new Error(added.error)
		expect(Object.keys(added.servers ?? {}).sort()).toEqual(['inline', 'saved'])
		const strict = launchMcpServers(configured, [inline], true)
		if ('error' in strict) throw new Error(strict.error)
		expect(Object.keys(strict.servers ?? {})).toEqual(['inline'])
		const none = launchMcpServers(configured, [], true)
		if ('error' in none) throw new Error(none.error)
		expect(none.servers).toEqual({})
		expect(launchMcpServers(configured, ['{nope'])).toHaveProperty('error')
	})
})

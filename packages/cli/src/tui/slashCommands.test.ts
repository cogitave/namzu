import { describe, expect, it } from 'vitest'

import {
	SLASH_COMMANDS,
	type SlashContext,
	initPrompt,
	matchSlashCommands,
	parseSlash,
	runSlash,
} from './slashCommands.js'

/**
 * A context with nothing interesting in it, plus whatever this test is about.
 *
 * Built through a helper rather than as literals so that a field added to
 * `SlashContext` lands in one place — the same reason `__fixtures__/agent-session.ts`
 * exists, and this file had two literals that would each have had to grow.
 */
function context(over: Partial<SlashContext> = {}): SlashContext {
	return {
		availableTools: [],
		providerSummary: null,
		modelSummary: null,
		usage: null,
		permissions: { skipPermissions: false, rules: [] },
		agentIds: [],
		instructionFiles: [],
		...over,
	}
}

const ctx: SlashContext = context()

const ctxWithTools: SlashContext = context({
	availableTools: ['Bash', 'Read', 'Edit'],
	providerSummary: 'anthropic-personal (anthropic)',
	modelSummary: 'claude-opus-4-7',
})

describe('matchSlashCommands', () => {
	it('returns all commands for a bare slash', () => {
		expect(matchSlashCommands('/')).toEqual(SLASH_COMMANDS)
	})

	it('filters by name prefix (case-insensitive)', () => {
		const names = matchSlashCommands('/me').map((c) => c.name)
		expect(names).toContain('memory')
		expect(names).not.toContain('help')
		expect(matchSlashCommands('/MO').map((c) => c.name)).toContain('model')
	})

	it('returns [] once a space is typed (now entering arguments)', () => {
		expect(matchSlashCommands('/model ')).toEqual([])
		expect(matchSlashCommands('/skill foo')).toEqual([])
	})

	it('returns [] for non-slash input', () => {
		expect(matchSlashCommands('hello')).toEqual([])
		expect(matchSlashCommands('')).toEqual([])
	})

	it('returns [] when nothing matches the prefix', () => {
		expect(matchSlashCommands('/zzz')).toEqual([])
	})
})

describe('parseSlash', () => {
	it('returns null for non-slash lines', () => {
		expect(parseSlash('hello world')).toBeNull()
		expect(parseSlash('')).toBeNull()
		expect(parseSlash('  ')).toBeNull()
	})

	it('tolerates leading whitespace', () => {
		expect(parseSlash('  /help')).toEqual({ name: 'help', args: [] })
	})

	it('splits args on whitespace', () => {
		expect(parseSlash('/model anthropic claude-opus-4-7')).toEqual({
			name: 'model',
			args: ['anthropic', 'claude-opus-4-7'],
		})
	})

	it('returns null for a bare slash', () => {
		expect(parseSlash('/')).toBeNull()
		expect(parseSlash('/ ')).toBeNull()
	})
})

describe('runSlash', () => {
	it('returns null for non-slash input', () => {
		expect(runSlash('plain message', ctx)).toBeNull()
	})

	it('reports unknown commands as system messages', () => {
		const r = runSlash('/nope', ctx)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('Unknown command')
	})

	it('/help lists every registered command', () => {
		const r = runSlash('/help', ctx)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') {
			for (const cmd of SLASH_COMMANDS) {
				expect(r.content).toContain(`/${cmd.name}`)
			}
		}
	})

	it('/clear returns a clear action', () => {
		expect(runSlash('/clear', ctx)).toEqual({ kind: 'clear' })
	})

	it('/quit and /exit both produce an exit action', () => {
		expect(runSlash('/quit', ctx)).toEqual({ kind: 'exit' })
		expect(runSlash('/exit', ctx)).toEqual({ kind: 'exit' })
	})

	it('/tools reports "no tools" when registry is empty', () => {
		const r = runSlash('/tools', ctx)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('No tools registered')
	})

	it('/tools lists registered tools when present', () => {
		const r = runSlash('/tools', ctxWithTools)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') {
			expect(r.content).toContain('Bash')
			expect(r.content).toContain('Read')
			expect(r.content).toContain('3')
		}
	})

	it('/provider says "not configured" when no provider', () => {
		const r = runSlash('/provider', ctx)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('No provider configured')
	})

	it('/provider shows summary when configured', () => {
		const r = runSlash('/provider', ctxWithTools)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') {
			expect(r.content).toContain('anthropic-personal')
			expect(r.content).toContain('claude-opus-4-7')
		}
	})

	it('/model re-opens the picker (repick action)', () => {
		expect(runSlash('/model', ctxWithTools)).toEqual({ kind: 'repick' })
	})
})

describe('/cost', () => {
	it('says so plainly before any turn has reported usage', () => {
		const r = runSlash('/cost', context({ usage: null }))
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('No usage reported yet')
	})

	it('prints exact figures rather than the status bar abbreviation', () => {
		const r = runSlash('/cost', context({ usage: { totalTokens: 12_345, costUsd: 0.0731 } }))
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') {
			// `12,345`, not `12.3k` — someone who asked wants the number.
			expect(r.content).toContain('12,345')
			expect(r.content).toContain('$0.0731')
		}
	})

	it('names a zero price as unreported rather than as free', () => {
		const r = runSlash('/cost', context({ usage: { totalTokens: 900, costUsd: 0 } }))
		if (r?.kind === 'message') expect(r.content).toContain('reported no price')
	})

	it('says the number is spend and not context fill', () => {
		// The two were conflated once, in the gauge. A command that prints one
		// without naming which it is invites the same misreading back.
		const r = runSlash('/cost', context({ usage: { totalTokens: 10, costUsd: 1 } }))
		if (r?.kind === 'message') {
			expect(r.content).toContain('Cumulative')
			expect(r.content).toContain('how full')
		}
	})
})

describe('/permissions', () => {
	it('reports that unreviewed calls are asked about by default', () => {
		const r = runSlash('/permissions', context())
		if (r?.kind === 'message') expect(r.content).toContain('you are asked')
	})

	it('names the flag when approval is automatic', () => {
		const r = runSlash(
			'/permissions',
			context({ permissions: { skipPermissions: true, rules: [] } }),
		)
		if (r?.kind === 'message') {
			expect(r.content).toContain('approved automatically')
			expect(r.content).toContain('--dangerously-skip-permissions')
		}
	})

	it('lists configured rules with their verb', () => {
		const r = runSlash(
			'/permissions',
			context({
				permissions: {
					skipPermissions: false,
					rules: [
						{ type: 'deny_by_name', toolNames: ['bash'] },
						{ type: 'allow_by_name', toolNames: ['read', 'glob'] },
					],
				},
			}),
		)
		if (r?.kind === 'message') {
			expect(r.content).toContain('deny')
			expect(r.content).toContain('bash')
			expect(r.content).toContain('allow')
			expect(r.content).toContain('read, glob')
		}
	})

	it('states that a rule outranks the approval setting', () => {
		// The precedence people get wrong, and wrong in the dangerous direction:
		// assuming the bypass flag lifts a `deny` they wrote. It does not.
		const r = runSlash(
			'/permissions',
			context({ permissions: { skipPermissions: true, rules: [] } }),
		)
		if (r?.kind === 'message') expect(r.content).toContain('never reopen what a')
	})
})

describe('/agents', () => {
	it('answers honestly when nothing is mounted', () => {
		const r = runSlash('/agents', context({ agentIds: [] }))
		if (r?.kind === 'message') {
			expect(r.content).toContain('No delegates')
			expect(r.content).toContain('does the work itself')
		}
	})

	it('lists the roster it was given', () => {
		const r = runSlash('/agents', context({ agentIds: ['general-purpose', 'reviewer'] }))
		if (r?.kind === 'message') {
			expect(r.content).toContain('general-purpose')
			expect(r.content).toContain('reviewer')
			expect(r.content).toContain('2')
		}
	})
})

describe('/init', () => {
	it('refuses without a provider, because it works by asking the agent', () => {
		const r = runSlash('/init', context({ providerSummary: null }))
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('needs a provider')
	})

	it('drives a turn rather than printing at the user', () => {
		// The whole design: the kernel reads the tree and writes the file, so
		// this must be a prompt and not a CLI-side generator.
		const r = runSlash('/init', context({ providerSummary: 'mock (mock)' }))
		expect(r?.kind).toBe('prompt')
	})

	it('tells the agent to verify claims and omit what it cannot establish', () => {
		// An AGENTS.md of plausible inventions is worse than none, because the
		// next agent obeys it. If this instruction goes missing the command
		// still "works" and quietly gets worse, so it is pinned.
		const p = initPrompt([])
		expect(p).toContain('Verify every claim against the tree')
		expect(p).toContain('leave it out')
	})

	it('asks for a new file when the project has no instructions', () => {
		const p = initPrompt([])
		expect(p).toContain('no AGENTS.md yet')
		expect(p).not.toContain('Do not overwrite')
	})

	it('refuses to overwrite instructions that already exist, and names them', () => {
		const p = initPrompt(['/repo/AGENTS.md', '/repo/pkg/AGENTS.md'])
		expect(p).toContain('Do not overwrite')
		expect(p).toContain('/repo/AGENTS.md')
		expect(p).toContain('/repo/pkg/AGENTS.md')
		expect(p).not.toContain('no AGENTS.md yet')
	})
})

describe('the new commands are reachable', () => {
	it('/help lists them, so they are discoverable without docs', () => {
		const r = runSlash('/help', ctx)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') {
			// Anchored on the whole name, not a prefix. `toContain('/agents')` was
			// the first version and it survived renaming the command to
			// `/agentsXX`, because that contains it — the same substring trap that
			// let a deleted command keep passing a `--help` assertion in
			// `cli.test.ts`. `/help` pads the name, so a real entry is the name
			// followed by whitespace.
			expect(r.content).toMatch(/\/cost\s/)
			expect(r.content).toMatch(/\/permissions\s/)
			expect(r.content).toMatch(/\/agents\s/)
		}
	})

	it('autocomplete offers them', () => {
		expect(matchSlashCommands('/co').map((c) => c.name)).toContain('cost')
		expect(matchSlashCommands('/ag').map((c) => c.name)).toContain('agents')
		expect(matchSlashCommands('/per').map((c) => c.name)).toContain('permissions')
	})
})

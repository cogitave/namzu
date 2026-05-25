import { describe, expect, it } from 'vitest'

import {
	SLASH_COMMANDS,
	type SlashContext,
	matchSlashCommands,
	parseSlash,
	runSlash,
} from './slashCommands.js'

const ctx: SlashContext = {
	availableTools: [],
	providerSummary: null,
	modelSummary: null,
}

const ctxWithTools: SlashContext = {
	availableTools: ['Bash', 'Read', 'Edit'],
	providerSummary: 'anthropic-personal (anthropic)',
	modelSummary: 'claude-opus-4-7',
}

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

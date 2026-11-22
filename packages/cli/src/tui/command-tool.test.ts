import { type ToolContext, generateTurnId } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { builtinCommandCatalogue } from './command-catalogue.js'
import {
	COMMAND_LISTING_BUDGET,
	type CommandCatalogueEntry,
	type CommandToolHost,
	buildCommandTool,
	renderCommandList,
	renderCommandListing,
	resolveCommand,
} from './command-tool.js'

function context(signal?: AbortSignal): ToolContext {
	return {
		sessionId: '019a0000-0000-7000-8000-0000000000f4',
		turnId: generateTurnId(),
		abortSignal: signal,
	} as unknown as ToolContext
}

function host(overrides: Partial<CommandToolHost> = {}) {
	const run = vi.fn<CommandToolHost['run']>(async () => ({ kind: 'ran', output: 'Goal created' }))
	const built: CommandToolHost = { catalogue: builtinCommandCatalogue(), run, ...overrides }
	return { run, tool: buildCommandTool(built) }
}

describe('the command tool', () => {
	it('refuses a never command without asking, naming it, and does not run it', async () => {
		const { run, tool } = host()
		const input = { name: 'login', args: ['codex'] }
		expect(tool.requiresApproval?.(input)).toBe(false)
		const result = await tool.execute(input, context())
		expect(result.success).toBe(false)
		expect(result.error).toContain('/login codex')
		expect(result.error).toMatch(/ask the person to type/i)
		expect(run).not.toHaveBeenCalled()
	})

	it('refuses the changing forms of a read-only command the same way', async () => {
		const { run, tool } = host()
		const result = await tool.execute({ name: 'tasks' }, context())
		expect(result.success).toBe(false)
		expect(result.error).toContain('/tasks')
		expect(run).not.toHaveBeenCalled()
	})

	it('asks before a confirm command and names the exact line', async () => {
		const { run, tool } = host()
		const input = { name: 'goal', args: ['write', 'the', 'changelog'] }
		expect(tool.requiresApproval?.(input)).toBe(true)
		expect(tool.isReadOnly?.(input)).toBe(false)
		expect(tool.presentCall?.(input)).toMatchObject({ label: '/goal write the changelog' })
		const result = await tool.execute(input, context())
		expect(result.success).toBe(true)
		expect(run).toHaveBeenCalledExactlyOnceWith('/goal write the changelog', {
			deferred: false,
		})
		expect(result.output).toContain('Ran /goal write the changelog')
		expect(result.output).toContain('Goal created')
	})

	it('runs a read command at once without asking', async () => {
		const { run, tool } = host()
		const input = { name: 'status' }
		expect(tool.requiresApproval?.(input)).toBe(false)
		expect(tool.isReadOnly?.(input)).toBe(true)
		const result = await tool.execute(input, context())
		expect(result.success).toBe(true)
		expect(run).toHaveBeenCalledExactlyOnceWith('/status', { deferred: false })
	})

	it('reads a command that only reads without asking, and asks for the form that changes', () => {
		const { tool } = host()
		expect(tool.requiresApproval?.({ name: 'tasks', args: ['list'] })).toBe(false)
		expect(tool.requiresApproval?.({ name: 'schedule' })).toBe(false)
		expect(tool.requiresApproval?.({ name: 'schedule', args: ['run', 'nightly'] })).toBe(true)
	})

	it('accepts the keyword spellings as a person types them', async () => {
		const { run, tool } = host()
		await tool.execute({ name: 'release notes' }, context())
		await tool.execute({ name: 'release', args: ['notes'] }, context())
		await tool.execute({ name: '/status', args: [] }, context())
		expect(run.mock.calls.map(([line]) => line)).toEqual([
			'/release notes',
			'/release notes',
			'/status',
		])
	})

	it('has no aliases: a hyphenated or unknown name is unknown', async () => {
		const { run, tool } = host()
		for (const name of ['release-notes', 'resume-session', 'nope']) {
			const result = await tool.execute({ name }, context())
			expect(result.success).toBe(false)
			expect(result.error).toMatch(/no command/i)
		}
		expect(run).not.toHaveBeenCalled()
	})

	it('puts a multi-line argument on one line', async () => {
		const { run, tool } = host()
		await tool.execute({ name: 'goal', args: ['fix\n/login', 'now'] }, context())
		expect(run.mock.calls[0]?.[0]).toBe('/goal fix /login now')
	})

	it('defers a command that ends or replaces the conversation until the turn is over', async () => {
		const queued = vi.fn<CommandToolHost['run']>(async () => ({ kind: 'queued' }))
		const tool = buildCommandTool({ catalogue: builtinCommandCatalogue(), run: queued })
		for (const name of ['clear', 'new', 'resume', 'fork', 'branch', 'rewind', 'compact', 'model']) {
			const args = name === 'model' ? ['some-model'] : []
			const result = await tool.execute({ name, args }, context())
			expect(result.success).toBe(true)
			expect(result.output).toMatch(/queued/i)
			expect(result.output).toMatch(/when this turn ends/i)
		}
		expect(queued.mock.calls.every(([, options]) => options.deferred)).toBe(true)
		expect(queued).toHaveBeenCalledTimes(8)
	})

	it('relays the reason a command cannot run here, and asks nothing', async () => {
		const reason = 'Fast mode is not offered by this model.'
		const run = vi.fn<CommandToolHost['run']>()
		const tool = buildCommandTool({
			catalogue: builtinCommandCatalogue(),
			run,
			unavailable: () => reason,
		})
		expect(tool.requiresApproval?.({ name: 'fast' })).toBe(false)
		const result = await tool.execute({ name: 'fast' }, context())
		expect(result.success).toBe(false)
		expect(result.error).toContain(reason)
		expect(run).not.toHaveBeenCalled()
	})

	it('does not claim success when the host fails', async () => {
		const tool = buildCommandTool({
			catalogue: builtinCommandCatalogue(),
			run: async () => {
				throw new Error('secret detail')
			},
		})
		const result = await tool.execute({ name: 'goal', args: ['x'] }, context())
		expect(result.success).toBe(false)
		expect(JSON.stringify(result)).not.toContain('secret detail')
		expect(result.error).toMatch(/do not say it ran/i)
	})

	it('answers list with the commands, never run ones only as names', async () => {
		const { tool } = host()
		const result = await tool.execute({ action: 'list' }, context())
		expect(result.success).toBe(true)
		expect(result.output).toContain('/goal')
		expect(result.output).toContain('/fast')
		expect(result.output).toContain('/ultrafast')
		expect(result.output).toContain('/login')
		expect(tool.requiresApproval?.({ action: 'list' })).toBe(false)
	})

	it('names the commands it cannot run in one trailing line', () => {
		const listing = renderCommandListing(builtinCommandCatalogue())
		const last = listing.split('\n').at(-1) ?? ''
		for (const name of [
			'setup',
			'config',
			'settings',
			'peers',
			'browser',
			'feedback',
			'archive',
			'unarchive',
			'exit',
			'add dir',
			'plugins',
			'login',
			'auth',
			'logout',
			'terminal setup',
			'permissions',
		]) {
			expect(last).toContain(`/${name}`)
		}
	})
})

describe('the generated listing', () => {
	it('stays within the budget and still carries the runnable and confirmable commands', () => {
		const listing = renderCommandListing(builtinCommandCatalogue())
		expect(listing.length).toBeLessThanOrEqual(COMMAND_LISTING_BUDGET)
		for (const name of ['goal', 'fast', 'ultrafast', 'status', 'schedule', 'clear']) {
			expect(listing).toContain(`/${name}`)
		}
	})

	it('stays within the budget with 100 user skills present, and does not name them', () => {
		const skills: CommandCatalogueEntry[] = Array.from({ length: 100 }, (_unused, index) => ({
			name: `user-skill-${index}`,
			description: `Does the thing number ${index} for the person with a long description that goes on.`,
			source: 'user',
		}))
		const catalogue = [...builtinCommandCatalogue(), ...skills]
		const listing = renderCommandListing(catalogue)
		expect(listing.length).toBeLessThanOrEqual(COMMAND_LISTING_BUDGET)
		expect(listing).not.toContain('user-skill-')
		expect(listing).toContain('/goal')
		expect(renderCommandList(catalogue)).not.toContain('user-skill-')
		const tool = buildCommandTool({ catalogue, run: vi.fn() })
		expect(tool.description.length).toBeLessThanOrEqual(COMMAND_LISTING_BUDGET)
		expect(resolveCommand(catalogue, 'user-skill-3')?.modelRun).toBe('never')
	})

	it('holds the budget even with a catalogue far larger than the built-in one', () => {
		const many: CommandCatalogueEntry[] = Array.from({ length: 300 }, (_unused, index) => ({
			name: `built${index}`,
			description: 'A long description that cannot fit three hundred times over',
			modelRun: 'confirm',
			source: 'builtin',
		}))
		expect(renderCommandListing(many).length).toBeLessThanOrEqual(COMMAND_LISTING_BUDGET)
	})
})

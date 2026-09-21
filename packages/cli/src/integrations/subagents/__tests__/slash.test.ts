import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_WORKFLOW, type SubagentActivity } from '../activity.js'
import { type Batch, NO_BATCHES_MESSAGE } from '../batches.js'
import { AGENTS_USAGE, type AgentsSlashContext, agentsSlashCommand } from '../slash.js'

const running: SubagentActivity = {
	viewId: 'agent-1',
	agentId: 'general-purpose',
	description: 'read',
	prompt: '',
	batchId: 'batch-1',
	workflowId: 'turn-live',
	workflowGroupId: 'group-1',
	phaseId: 'phase-1',
	workflow: 'Audit',
	phase: 'Work',
	phaseSequence: 1,
	status: 'working',
	startedAt: 1_000,
	transcript: [],
}

const finished: Batch = {
	id: 'turn-old',
	name: DEFAULT_AGENT_WORKFLOW,
	startedAt: 10,
	phases: ['Work'],
	agentsDone: 1,
	agentsTotal: 1,
	tokensTotal: 5,
	elapsedMs: 20,
	live: false,
}

function context(over: Partial<AgentsSlashContext> = {}): AgentsSlashContext {
	return { liveAgents: () => [], now: () => 2_000, ...over }
}

describe('/agents', () => {
	it('opens the cockpit bare or with running, and lists configured agents with available', async () => {
		expect(await agentsSlashCommand([], context())).toEqual({ kind: 'agent-cockpit' })
		expect(await agentsSlashCommand(['running'], context())).toEqual({ kind: 'agent-cockpit' })
		expect(await agentsSlashCommand(['available'], context())).toEqual({
			kind: 'available-agents',
		})
	})

	it('lists live and saved batches together, newest first', async () => {
		const result = await agentsSlashCommand(
			['batches'],
			context({ liveAgents: () => [running], savedBatches: async () => [finished] }),
		)
		expect(result).toEqual({
			kind: 'batches',
			listing: {
				batches: [
					{
						id: 'turn-live',
						name: 'Audit',
						startedAt: 1_000,
						phases: ['Work'],
						agentsDone: 0,
						agentsTotal: 1,
						tokensTotal: 0,
						elapsedMs: 1_000,
						live: true,
					},
					finished,
				],
				omitted: 0,
			},
		})
	})

	it('answers an empty listing with a line, not an empty picker', async () => {
		expect(await agentsSlashCommand(['batches'], context())).toEqual({
			kind: 'message',
			content: NO_BATCHES_MESSAGE,
		})
	})

	it('still lists the live half when saved batches cannot be read', async () => {
		const warn = vi.fn()
		const result = await agentsSlashCommand(
			['batches'],
			context({
				liveAgents: () => [running],
				savedBatches: async () => {
					throw new Error('index unavailable')
				},
				log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
			}),
		)
		expect(result.kind).toBe('batches')
		expect(result.kind === 'batches' && result.listing.batches.map((batch) => batch.id)).toEqual([
			'turn-live',
		])
		expect(warn).toHaveBeenCalled()
	})

	it('treats runs as an unknown subcommand, with no alias to batches', async () => {
		const savedBatches = vi.fn(async () => [finished])
		expect(await agentsSlashCommand(['runs'], context({ savedBatches }))).toEqual({
			kind: 'message',
			content: `Usage: ${AGENTS_USAGE}`,
		})
		expect(savedBatches).not.toHaveBeenCalled()
		expect(AGENTS_USAGE).toBe('/agents [running|available|batches]')
	})

	it('prints the usage for anything else, including extra arguments', async () => {
		for (const args of [['batch'], ['batches', 'all'], ['running', 'now']]) {
			expect(await agentsSlashCommand(args, context())).toEqual({
				kind: 'message',
				content: `Usage: ${AGENTS_USAGE}`,
			})
		}
	})
})

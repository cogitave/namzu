import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	type AgentDefinition,
	AgentRegistry,
	type LLMProvider,
	LocalTaskGateway,
	type ToolContext,
} from '@namzu/sdk'

import { createSubagentRuntime } from '../runtime.js'

/**
 * A delegated run belongs inside the turn that asked for it.
 *
 * The kernel supports this end to end — the executing tool's span reaches
 * `createTask`, survives `configOverrides`, is stamped onto the child config
 * after the host's `configBuilder` runs, and becomes the child run's trace
 * parent. Every hop was built and tested. The `Agent` tool simply did not pass
 * the first one, so a sub-agent opened its own ROOT trace and the delegation
 * structure — the one thing a delegation trace exists to record — was absent.
 *
 * The gateway is constructed inside the runtime, so the spy goes on its
 * prototype: this drives the real tool through the real wiring rather than
 * re-deriving what the tool ought to do. A unit test on the span helper would
 * have passed throughout the defect.
 */

const fakeSpan = { __brand: 'span' } as unknown as NonNullable<ToolContext['parentSpan']>

function toolContext(parentSpan?: ToolContext['parentSpan']): ToolContext {
	return { runId: 'run_test', ...(parentSpan ? { parentSpan } : {}) } as unknown as ToolContext
}

async function buildAgentTool(extra: { projectInstructions?: string } = {}) {
	const created: Record<string, unknown>[] = []
	const registered: AgentDefinition[] = []

	vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation((def) => {
		for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
	})
	vi.spyOn(LocalTaskGateway.prototype, 'createTask').mockImplementation(async (options) => {
		created.push(options as unknown as Record<string, unknown>)
		return { taskId: 'tsk_1' } as never
	})
	vi.spyOn(LocalTaskGateway.prototype, 'waitForTask').mockResolvedValue({
		state: 'completed',
		result: { status: 'completed', result: 'done' },
	} as never)

	const runtime = await createSubagentRuntime({
		cwd: '/tmp',
		model: 'test-model',
		buildProvider: () => ({}) as LLMProvider,
		buildTools: () => ({}) as never,
		...extra,
	})

	return { agentTool: runtime.agentTool, created, registered }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('the Agent tool parents a delegated run to the turn that asked for it', () => {
	it('passes the executing tool span through to the child run', async () => {
		const { agentTool, created } = await buildAgentTool()

		await agentTool.execute({ description: 'audit', prompt: 'do a thing' }, toolContext(fakeSpan))

		expect(created).toHaveLength(1)
		expect(created[0]?.parentSpan).toBe(fakeSpan)
	})

	it('omits the key entirely when the turn supplied no span', async () => {
		// Not the same as passing `undefined`: the kernel branches on the
		// property's presence, and a top-level run with no parent is correct
		// to start its own root. Refusing to invent one is the other half of
		// the fix, not an edge case.
		const { agentTool, created } = await buildAgentTool()

		await agentTool.execute({ description: 'audit', prompt: 'do a thing' }, toolContext())

		expect(created[0]).not.toHaveProperty('parentSpan')
	})

	it('parents a dynamically defined specialist too', async () => {
		// The `role` branch registers a fresh agent before delegating, and it
		// is a second path to the same `createTask`. One of two paths carrying
		// a signal is how this class of defect survives a green suite.
		const { agentTool, created } = await buildAgentTool()

		await agentTool.execute(
			{ description: 'audit', prompt: 'do a thing', role: 'You are an auditor' },
			toolContext(fakeSpan),
		)

		expect(created[0]?.parentSpan).toBe(fakeSpan)
	})
})

/**
 * The project's standing instructions bind a specialist the model invents at
 * call time, not only the pre-registered general-purpose sub-agent.
 *
 * `role` is a SECOND registration path to the same definition builder, and one
 * of two paths carrying a signal is how this class of defect survives a green
 * suite: the delegation everyone tests would honour the project's rules and
 * the one the model actually reaches for — a named specialist — would not.
 */
describe('a sub-agent is bound by the project it works in', () => {
	const INSTRUCTIONS = '## Project instructions\n\nNever use a default export.'

	it('gives the general-purpose sub-agent the block', async () => {
		const { registered } = await buildAgentTool({ projectInstructions: INSTRUCTIONS })

		const general = registered.find((d) => d.info.id === 'general-purpose')
		const config = (await general?.configBuilder?.({})) as { systemPrompt?: string } | undefined
		expect(config?.systemPrompt).toContain('Never use a default export.')
	})

	it('gives a specialist defined at call time the same block', async () => {
		const { agentTool, registered } = await buildAgentTool({ projectInstructions: INSTRUCTIONS })

		await agentTool.execute(
			{ description: 'audit', prompt: 'do a thing', role: 'You are a security auditor' },
			toolContext(),
		)

		const specialist = registered.find((d) => d.info.id.startsWith('dyn-'))
		if (!specialist?.configBuilder) {
			throw new Error('no dynamic specialist was registered — this test proves nothing')
		}
		const prompt = String(
			((await specialist.configBuilder({})) as { systemPrompt?: string }).systemPrompt ?? '',
		)
		expect(prompt).toContain('You are a security auditor')
		expect(prompt).toContain('Never fabricate.')
		expect(prompt).toContain('Never use a default export.')
		// Order is the containment: a persona and a project file are both text
		// the model can influence, and both sit after the guardrails.
		expect(prompt.indexOf('Never fabricate.')).toBeLessThan(
			prompt.indexOf('Never use a default export.'),
		)
	})

	it('adds nothing when the project declares none', async () => {
		const { registered } = await buildAgentTool()

		const general = registered.find((d) => d.info.id === 'general-purpose')
		const config = (await general?.configBuilder?.({})) as { systemPrompt?: string } | undefined
		expect(config?.systemPrompt).not.toContain('Project instructions')
	})
})

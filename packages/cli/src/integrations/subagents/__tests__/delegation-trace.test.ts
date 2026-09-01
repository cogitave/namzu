import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	type AgentDefinition,
	AgentRegistry,
	type LLMProvider,
	LocalTaskScheduler,
	type ProjectInstructionContext,
	type ReactiveAgentConfig,
	type ResumeHandler,
	type SandboxProvider,
	type ToolContext,
	asRunId,
	createProjectInstructionMessage,
} from '@namzu/sdk'

import { GENERAL_PURPOSE_SUBAGENT, createSubagentRuntime } from '../runtime.js'

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
	return {
		runId: 'run_test',
		abortSignal: new AbortController().signal,
		...(parentSpan ? { parentSpan } : {}),
	} as unknown as ToolContext
}

async function buildAgentTool(
	extra: {
		projectInstructionContext?: () => ProjectInstructionContext
		sandboxProvider?: SandboxProvider
		sandboxWorkspace?: 'working-directory' | 'ephemeral'
		sandboxTeardownTimeoutMs?: number
		resolveResumeHandler?: (runId: ToolContext['runId']) => ResumeHandler | undefined
	} = {},
) {
	const created: Record<string, unknown>[] = []
	const registered: AgentDefinition[] = []

	vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation((def) => {
		for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
	})
	vi.spyOn(LocalTaskScheduler.prototype, 'createTask').mockImplementation(async (options) => {
		created.push(options as unknown as Record<string, unknown>)
		return { taskId: 'tsk_1' } as never
	})
	vi.spyOn(LocalTaskScheduler.prototype, 'waitForTask').mockResolvedValue({
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

	return {
		agentTool: runtime.agentTool,
		activity: runtime.activity,
		close: runtime.close,
		created,
		registered,
	}
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('the Agent tool parents a delegated run to the turn that asked for it', () => {
	it('carries parsed cockpit annotations through the production tool into activity', async () => {
		const { agentTool, activity, close } = await buildAgentTool()
		try {
			const parsed = agentTool.inputSchema.parse({
				description: 'API research',
				prompt: 'inspect provider APIs',
				workflow: 'Basicbox research',
				phase: 'Research',
				phase_order: 1,
			})
			await agentTool.execute(parsed, toolContext())

			expect(activity.getSnapshot()[0]).toMatchObject({
				workflowId: 'run_test',
				workflow: 'Basicbox research',
				phase: 'Research',
				phaseOrder: 1,
				phaseSequence: 1,
			})
		} finally {
			await close()
		}
	})

	it('rejects cockpit annotations the bounded monitor cannot represent exactly', async () => {
		const { agentTool, close } = await buildAgentTool()
		try {
			expect(
				agentTool.inputSchema.safeParse({
					description: 'audit',
					prompt: 'inspect',
					workflow: 'w'.repeat(241),
				}),
			).toMatchObject({ success: false })
			expect(
				agentTool.inputSchema.safeParse({
					description: 'audit',
					prompt: 'inspect',
					phase_order: 10_001,
				}),
			).toMatchObject({ success: false })
		} finally {
			await close()
		}
	})

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
			{
				description: 'audit',
				prompt: 'do a thing',
				role: 'You are an auditor',
			},
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
	const projectInstructionContext = () => ({
		prepareInitialSnapshot: () => createProjectInstructionMessage(INSTRUCTIONS, ['AGENTS.md']),
		observeToolResult: () => undefined,
	})

	it('gives the general-purpose sub-agent the block', async () => {
		const { registered } = await buildAgentTool({ projectInstructionContext })

		const general = registered.find((d) => d.info.id === 'general-purpose')
		const config = (await general?.configBuilder?.({})) as
			| { projectInstructionContext?: ProjectInstructionContext }
			| undefined
		const signal = new AbortController().signal
		const snapshot = await config?.projectInstructionContext?.prepareInitialSnapshot?.({
			messages: [],
			signal,
		})
		expect(snapshot?.content).toContain('Never use a default export.')
	})

	it('gives a specialist defined at call time the same block', async () => {
		const { agentTool, registered } = await buildAgentTool({
			projectInstructionContext,
		})

		await agentTool.execute(
			{
				description: 'audit',
				prompt: 'do a thing',
				role: 'You are a security auditor',
			},
			toolContext(),
		)

		const specialist = registered.find((d) => d.info.id.startsWith('dyn-'))
		if (!specialist?.configBuilder) {
			throw new Error('no dynamic specialist was registered — this test proves nothing')
		}
		const config = (await specialist.configBuilder({})) as {
			systemPrompt?: string
			projectInstructionContext?: ProjectInstructionContext
		}
		const prompt = String(config.systemPrompt ?? '')
		const signal = new AbortController().signal
		const snapshot = await config.projectInstructionContext?.prepareInitialSnapshot?.({
			messages: [],
			signal,
		})
		expect(prompt).toContain('You are a security auditor')
		expect(prompt).toContain('Never fabricate.')
		expect(snapshot?.content).toContain('Never use a default export.')
	})

	it('adds nothing when the project declares none', async () => {
		const { registered } = await buildAgentTool()

		const general = registered.find((d) => d.info.id === 'general-purpose')
		const config = (await general?.configBuilder?.({})) as
			| { projectInstructionContext?: ProjectInstructionContext }
			| undefined
		expect(config?.projectInstructionContext).toBeUndefined()
	})
})

describe('a sub-agent shares the session workspace policy', () => {
	it('carries working-directory into the child agent config', async () => {
		const sandboxProvider = {} as SandboxProvider
		const { registered } = await buildAgentTool({
			sandboxProvider,
			sandboxWorkspace: 'working-directory',
		})
		const general = registered.find((definition) => definition.info.id === GENERAL_PURPOSE_SUBAGENT)

		const config = (await general?.configBuilder?.({})) as ReactiveAgentConfig | undefined

		expect(config?.sandboxProvider).toBe(sandboxProvider)
		expect(config?.sandbox).toEqual({ workspace: 'working-directory' })
	})
})

describe('a sub-agent shares the parent run review channel', () => {
	it('passes only the handler belonging to the run that invoked Agent', async () => {
		const handler = vi.fn() as ResumeHandler
		const { agentTool, created } = await buildAgentTool({
			resolveResumeHandler: (runId) => (String(runId) === 'run_test' ? handler : undefined),
		})

		await agentTool.execute({ description: 'audit', prompt: 'do a thing' }, toolContext())

		expect(
			(created[0]?.configOverrides as { resumeHandler?: ResumeHandler } | undefined)?.resumeHandler,
		).toBe(handler)
	})

	it('installs a fail-closed review channel when the parent run owns none', async () => {
		const { agentTool, created } = await buildAgentTool({
			resolveResumeHandler: () => undefined,
		})

		await agentTool.execute({ description: 'audit', prompt: 'do a thing' }, toolContext())

		const handler = (created[0]?.configOverrides as { resumeHandler?: ResumeHandler } | undefined)
			?.resumeHandler
		expect(handler).toBeTypeOf('function')
		await expect(
			handler?.({
				type: 'tool_review',
				runId: asRunId('run_child'),
				checkpointId: 'chk_child' as never,
				toolCalls: [],
			}),
		).resolves.toEqual(
			expect.objectContaining({
				action: 'abort',
				reason: expect.stringMatching(/no longer owns an interactive review channel/i),
			}),
		)
	})
})

describe('a sub-agent stays inside the parent session boundary', () => {
	it('carries the exact sandbox provider and teardown bound into its agent config', async () => {
		const sandboxProvider = { id: 'same-boundary' } as SandboxProvider
		const { registered } = await buildAgentTool({
			sandboxProvider,
			sandboxTeardownTimeoutMs: 37,
		})

		const general = registered.find((definition) => definition.info.id === GENERAL_PURPOSE_SUBAGENT)
		const config = (await general?.configBuilder?.({})) as ReactiveAgentConfig | undefined

		expect(config?.sandboxProvider).toBe(sandboxProvider)
		expect(config?.sandboxTeardownTimeoutMs).toBe(37)
	})
})

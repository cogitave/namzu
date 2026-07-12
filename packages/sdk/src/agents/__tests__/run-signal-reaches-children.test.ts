// Current-code invariants asserted (2026-07-12, ses_017 P4):
// - SupervisorAgent hands its children the RUN's signal, not the agent's own raw
//   `abortController`. Concretely: the `AgentTaskContext.parentAbortController` it
//   builds aborts when the caller-supplied `AgentInput.signal` aborts.
//   Before P4 it passed `this.abortController` — the agent's own controller — so the
//   ONLY thing that could stop a child was `agent.cancel()`, and `agent.cancel()` is
//   unusable from the API (one agent INSTANCE is shared across every run of an agent
//   id, and the controller is never reset, so cancelling one run poisons all the
//   others and every future run). A per-run cancel therefore stopped the supervisor's
//   own loop and left every child running.
// - `agent.cancel()` still reaches the children too: the composed run signal carries
//   the agent's own controller as well, so both sources abort the same children.
// - PipelineAgent observes `input.signal` at all (it read only its own
//   `abortController` and never looked at the caller's signal), and a cancelled
//   pipeline reports `cancelled`, not `failed`.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ProviderRequestError } from '../../provider/errors.js'
import type { PipelineAgentConfig, SupervisorAgentConfig } from '../../types/agent/index.js'
import type { AgentManagerContract } from '../../types/agent/manager.js'
import type { AgentTaskContext } from '../../types/agent/task.js'
import type { ProjectId, SessionId, TenantId, ThreadId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../types/provider/index.js'
import { PipelineAgent } from '../PipelineAgent.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

/**
 * Capture the `AgentTaskContext` the supervisor builds — that object IS the wiring
 * under test: `AgentManager.spawn` derives every child's abort controller from its
 * `parentAbortController` (`createChildAbortController`), and the child agent
 * receives it as its own `AgentInput.signal`.
 */
const captured: AgentTaskContext[] = []

// The stub must implement the WHOLE gateway surface. A partial one makes the
// supervisor's run die on the first missing method, `runSignal.dispose()` then
// unhooks the run signal in the `finally`, and a later abort silently reaches
// nothing — which looks exactly like the bug under test.
vi.mock('../../gateway/local.js', () => ({
	LocalTaskGateway: class {
		constructor(_manager: unknown, taskContext: AgentTaskContext) {
			captured.push(taskContext)
		}
		async createTask() {
			throw new Error('not used')
		}
		async waitForTask() {
			throw new Error('not used')
		}
		async continueTask() {}
		cancelTask() {}
		getTask() {
			return undefined
		}
		listTasks() {
			return []
		}
		onTaskCompleted() {
			return () => {}
		}
	},
}))

/** Provider whose chat hangs until the run signal aborts, then rejects 'aborted'. */
function hangingProvider(): LLMProvider {
	return {
		id: 'fake',
		name: 'Fake',
		chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			return new Promise((_resolve, reject) => {
				params.signal?.addEventListener(
					'abort',
					() =>
						reject(new ProviderRequestError('aborted', { kind: 'aborted', providerId: 'fake' })),
					{ once: true },
				)
			})
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
}

function supervisorConfig(): SupervisorAgentConfig {
	return {
		model: 'm',
		tokenBudget: 1_000_000,
		timeoutMs: 600_000,
		maxIterations: 10,
		provider: hangingProvider(),
		agentIds: [],
		// Forces the LocalTaskGateway branch — the one that builds the task context.
		agentManager: {} as AgentManagerContract,
		systemPrompt: 'You are a supervisor.',
		sessionId: 'ses_test' as SessionId,
		threadId: 'thr_test' as ThreadId,
		projectId: 'prj_test' as ProjectId,
		tenantId: 'tnt_test' as TenantId,
	}
}

function makeSupervisor(): SupervisorAgent {
	return new SupervisorAgent({
		id: 's1',
		name: 'S1',
		version: '1.0.0',
		category: 'test',
		description: 'test supervisor',
	})
}

const workdir = (): string => mkdtempSync(join(tmpdir(), 'namzu-p4-'))

describe('SupervisorAgent — children hang off the run signal', () => {
	it("aborts its children when the CALLER's per-run signal aborts", async () => {
		captured.length = 0
		const agent = makeSupervisor()
		const external = new AbortController()

		const runPromise = agent.run(
			{
				messages: [createUserMessage('coordinate the work')],
				workingDirectory: workdir(),
				signal: external.signal,
			},
			supervisorConfig(),
		)

		await new Promise((r) => setTimeout(r, 50))

		const taskContext = captured.at(-1)
		expect(taskContext, 'supervisor built no task context').toBeDefined()
		expect(taskContext?.parentAbortController.signal.aborted).toBe(false)

		// This is the API's only handle on a run. Before P4 it reached the supervisor's
		// own loop and NOTHING else: the children were wired to the agent's controller.
		external.abort()

		expect(taskContext?.parentAbortController.signal.aborted).toBe(true)

		const result = await runPromise
		expect(result.status).toBe('cancelled')
	})

	it('still aborts its children on agent.cancel()', async () => {
		captured.length = 0
		const agent = makeSupervisor()

		const runPromise = agent.run(
			{ messages: [createUserMessage('coordinate')], workingDirectory: workdir() },
			supervisorConfig(),
		)

		await new Promise((r) => setTimeout(r, 50))

		const taskContext = captured.at(-1)
		expect(taskContext?.parentAbortController.signal.aborted).toBe(false)

		await agent.cancel()

		expect(taskContext?.parentAbortController.signal.aborted).toBe(true)
		expect((await runPromise).status).toBe('cancelled')
	})

	it('starts children already aborted when the run signal arrives pre-aborted', async () => {
		captured.length = 0
		const agent = makeSupervisor()

		const result = await agent.run(
			{
				messages: [createUserMessage('coordinate')],
				workingDirectory: workdir(),
				signal: AbortSignal.abort(),
			},
			supervisorConfig(),
		)

		expect(captured.at(-1)?.parentAbortController.signal.aborted).toBe(true)
		expect(result.status).toBe('cancelled')
	})
})

describe('PipelineAgent — cancellation', () => {
	function pipelineConfig(steps: PipelineAgentConfig['steps']): PipelineAgentConfig {
		return {
			model: 'm',
			tokenBudget: 1_000,
			timeoutMs: 60_000,
			provider: hangingProvider(),
			steps,
		}
	}

	function makePipeline(): PipelineAgent {
		return new PipelineAgent({
			id: 'p1',
			name: 'P1',
			version: '1.0.0',
			category: 'test',
			description: 'test pipeline',
		})
	}

	it("observes the caller's input.signal and stops issuing steps", async () => {
		const agent = makePipeline()
		const external = new AbortController()
		const ran: string[] = []

		const result = await agent.run(
			{
				messages: [createUserMessage('go')],
				workingDirectory: workdir(),
				signal: external.signal,
			},
			pipelineConfig([
				{
					name: 'first',
					execute: async () => {
						ran.push('first')
						// Cancel arrives while step one is running.
						external.abort()
						return 'one'
					},
				},
				{
					name: 'second',
					execute: async () => {
						ran.push('second')
						return 'two'
					},
				},
			]),
		)

		// The step already executing runs to completion — cancellation bounds the loop,
		// not the work already in flight (bound-the-call-not-the-attempt). The NEXT step
		// is never issued. Before P4 both ran: `input.signal` was invisible to this agent.
		expect(ran).toEqual(['first'])
		expect(result.stepResults.map((s) => s.status)).toEqual(['completed', 'skipped'])

		// ...and the run reports CANCELLED. It used to report `failed`, because the
		// skipped step left completedSteps < totalSteps — indistinguishable, to a
		// caller, from a step that blew up.
		expect(result.status).toBe('cancelled')
		expect(result.stopReason).toBe('cancelled')
	})

	it('completes normally when nothing cancels it', async () => {
		const agent = makePipeline()
		const result = await agent.run(
			{ messages: [createUserMessage('go')], workingDirectory: workdir() },
			pipelineConfig([{ name: 'only', execute: async () => 'done' }]),
		)

		expect(result.status).toBe('completed')
		expect(result.stopReason).toBe('end_turn')
	})
})

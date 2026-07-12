// Current-code invariants asserted (2026-07-12, ses_017 P3):
//
// The API minted a run id, `ReactiveAgent` dropped it, `query()` minted a second one,
// and the SSE mapper substituted its own `runId` argument onto every event — so the
// two ids never met and no client could see the split. A persisted HITL decision would
// have named the SDK's run while the route answering it named the API's. This is the
// [one-canonical-name] failure: two names for one identity, with the translation buried
// in the middle.
//
//   - A caller-supplied run id IS the run id: it reaches the run record (`result.runId`),
//     EVERY emitted `RunEvent`, and the run's on-disk directory name. All three agree,
//     and no other run directory is created.
//   - An agent given no run id mints exactly ONE. The id on the result, on every event,
//     and on disk is that same one — there is no second id anywhere.
//   - Every archetype honours a supplied id: Reactive, Supervisor, Pipeline, Router. The
//     bug was that one agent got it right and the others did not, so each gets its own
//     test.
//   - RouterAgent hands its run id DOWN to the delegate it routes to. A route is a tail
//     call, not a spawn: the router keeps no run record of its own, so the delegate's
//     `query()` must open the run under the caller's id or the id would name nothing.
//   - A supervisor's spawned CHILD run does NOT inherit the parent's id — it is its own
//     run, with its own record and directory, linked by `parentRunId`. This was the
//     existing behaviour (children minted their own ids because the shipped config
//     builders discarded `options.runId` entirely); it is preserved deliberately, by
//     clearing `runId` out of the inherited `factoryOptions` in `AgentManager.spawn`.
//     Without that clear, threading the id through the builders would have made every
//     child open a run record under its parent's id.
//
// These tests drive the real agents through the production `query()` pipeline against a
// fake provider and a real `RunDiskStore`.
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { DefaultPathBuilder } from '../../session/workspace/path-builder.js'
import type { TaskGateway } from '../../types/agent/gateway.js'
import type {
	AgentInput,
	PipelineAgentConfig,
	ReactiveAgentConfig,
	RouterAgentConfig,
	SupervisorAgentConfig,
} from '../../types/agent/index.js'
import type { ProjectId, RunId, SessionId, TenantId, ThreadId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../types/provider/index.js'
import type { RunEvent } from '../../types/run/index.js'
import { PipelineAgent } from '../PipelineAgent.js'
import { ReactiveAgent } from '../ReactiveAgent.js'
import { RouterAgent } from '../RouterAgent.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

const SESSION_ID = 'ses_test' as SessionId
const THREAD_ID = 'thr_test' as ThreadId
const PROJECT_ID = 'prj_test' as ProjectId
const TENANT_ID = 'tnt_test' as TenantId

/** The id the caller (the API, in production) minted for this run. */
const CALLER_RUN_ID = 'run_from_the_caller' as RunId

const USAGE = {
	promptTokens: 10,
	completionTokens: 10,
	totalTokens: 20,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** Ends its turn on the first call — one iteration, no tools. */
function stoppingProvider(): LLMProvider {
	return {
		id: 'fake',
		name: 'Fake',
		async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			return {
				id: 'r',
				model: 'm',
				message: { role: 'assistant', content: 'all done' },
				finishReason: 'stop',
				usage: USAGE,
			} as ChatCompletionResponse
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
}

/** A gateway that launches nothing — the supervisor run makes a direct model call. */
function emptyGateway(): TaskGateway {
	return {
		async createTask() {
			throw new Error('not used')
		},
		async waitForTask() {
			throw new Error('not used')
		},
		async continueTask() {},
		cancelTask() {},
		getTask() {
			return undefined
		},
		listTasks() {
			return []
		},
		onTaskCompleted() {
			return () => {}
		},
	}
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-ses017-p3-'))
}

function runsDirOf(cwd: string): string {
	return join(
		new DefaultPathBuilder(join(cwd, '.namzu')).sessionDir(PROJECT_ID, SESSION_ID),
		'runs',
	)
}

/** Every run directory that reached disk, by name. Directory name IS the run id. */
function runDirsOnDisk(cwd: string): string[] {
	const dir = runsDirOf(cwd)
	if (!existsSync(dir)) return []
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort()
}

function scope() {
	return {
		sessionId: SESSION_ID,
		threadId: THREAD_ID,
		projectId: PROJECT_ID,
		tenantId: TENANT_ID,
	}
}

function reactiveConfig(runId?: RunId): ReactiveAgentConfig {
	return {
		model: 'm',
		tokenBudget: 1_000_000,
		timeoutMs: 600_000,
		maxIterations: 5,
		provider: stoppingProvider(),
		tools: new ToolRegistry(),
		systemPrompt: 'You are a worker.',
		runId,
		...scope(),
	}
}

function supervisorConfig(runId?: RunId): SupervisorAgentConfig {
	return {
		model: 'm',
		tokenBudget: 1_000_000,
		timeoutMs: 600_000,
		maxIterations: 5,
		provider: stoppingProvider(),
		agentIds: [],
		gateway: emptyGateway(),
		systemPrompt: 'You are a supervisor.',
		runId,
		...scope(),
	}
}

function input(cwd: string): AgentInput {
	return { messages: [createUserMessage('do the thing')], workingDirectory: cwd }
}

function reactiveAgent(id = 'r1'): ReactiveAgent {
	return new ReactiveAgent({
		id,
		name: id,
		version: '1.0.0',
		category: 'test',
		description: 'test reactive',
	})
}

/** Distinct `runId`s seen across a captured event stream. */
function idsInEvents(events: RunEvent[]): string[] {
	return [...new Set(events.map((e) => e.runId as string))].sort()
}

describe('a caller-supplied run id is THE run id (ses_017 P3)', () => {
	it('reaches the run record, every RunEvent, and the on-disk run directory', async () => {
		const cwd = tmp()
		const events: RunEvent[] = []

		const result = await reactiveAgent().run(input(cwd), reactiveConfig(CALLER_RUN_ID), (e) => {
			events.push(e)
		})

		// 1. the run record
		expect(result.runId).toBe(CALLER_RUN_ID)

		// 2. every event — not "most", not "the first one"
		expect(events.length).toBeGreaterThan(0)
		expect(idsInEvents(events)).toEqual([CALLER_RUN_ID])

		// 3. the on-disk directory, whose NAME is the run id. Exactly one run
		//    directory exists: the SDK did not also mint an id of its own and
		//    open a second run beside it.
		expect(runDirsOnDisk(cwd)).toEqual([CALLER_RUN_ID])
		expect(existsSync(join(runsDirOf(cwd), CALLER_RUN_ID, 'run.json'))).toBe(true)
	})

	it('an agent given no run id mints exactly one and uses it everywhere', async () => {
		const cwd = tmp()
		const events: RunEvent[] = []

		const result = await reactiveAgent().run(input(cwd), reactiveConfig(undefined), (e) => {
			events.push(e)
		})

		const onDisk = runDirsOnDisk(cwd)

		expect(onDisk).toHaveLength(1)
		expect(idsInEvents(events)).toEqual([result.runId as string])
		expect(onDisk).toEqual([result.runId as string])
	})
})

describe('every archetype honours a supplied run id (ses_017 P3)', () => {
	it('ReactiveAgent', async () => {
		const events: RunEvent[] = []
		const result = await reactiveAgent().run(input(tmp()), reactiveConfig(CALLER_RUN_ID), (e) => {
			events.push(e)
		})

		expect(result.runId).toBe(CALLER_RUN_ID)
		expect(idsInEvents(events)).toEqual([CALLER_RUN_ID])
	})

	it('SupervisorAgent', async () => {
		const events: RunEvent[] = []
		const agent = new SupervisorAgent({
			id: 's1',
			name: 'S1',
			version: '1.0.0',
			category: 'test',
			description: 'test supervisor',
		})

		const result = await agent.run(input(tmp()), supervisorConfig(CALLER_RUN_ID), (e) => {
			events.push(e)
		})

		expect(result.runId).toBe(CALLER_RUN_ID)
		expect(idsInEvents(events)).toEqual([CALLER_RUN_ID])
	})

	it('PipelineAgent', async () => {
		const events: RunEvent[] = []
		const agent = new PipelineAgent({
			id: 'p1',
			name: 'P1',
			version: '1.0.0',
			category: 'test',
			description: 'test pipeline',
		})

		const seenByStep: RunId[] = []
		const config: PipelineAgentConfig = {
			model: 'm',
			tokenBudget: 1_000,
			timeoutMs: 60_000,
			runId: CALLER_RUN_ID,
			steps: [
				{
					name: 'only-step',
					async execute(_in, ctx) {
						// The step context carries the run id too — a pipeline step that
						// writes an artifact names it by this id.
						seenByStep.push(ctx.runId)
						return 'done'
					},
				},
			],
			...scope(),
		}

		const result = await agent.run(input(tmp()), config, (e) => {
			events.push(e)
		})

		expect(result.runId).toBe(CALLER_RUN_ID)
		expect(seenByStep).toEqual([CALLER_RUN_ID])
		expect(idsInEvents(events)).toEqual([CALLER_RUN_ID])
	})

	it('RouterAgent — and its delegate runs under the same id, not a fresh one', async () => {
		const cwd = tmp()
		const events: RunEvent[] = []

		const agent = new RouterAgent({
			id: 'rt1',
			name: 'RT1',
			version: '1.0.0',
			category: 'test',
			description: 'test router',
		})

		const delegate = reactiveAgent('worker')
		const config: RouterAgentConfig = {
			...reactiveConfig(CALLER_RUN_ID),
			routes: [{ agentId: 'worker', agent: delegate, description: 'does the work' }],
			fallbackAgentId: 'worker',
			maxRoutingRetries: 1,
			invocationState: { tenantId: TENANT_ID },
		}

		const result = await agent.run(input(cwd), config, (e) => {
			events.push(e)
		})

		expect(result.runId).toBe(CALLER_RUN_ID)
		// The router emits its own lifecycle events AND the delegate's query emits a
		// full stream. Under P3 they are one run, so one id covers both.
		expect(idsInEvents(events)).toEqual([CALLER_RUN_ID])
		expect(result.delegateResult.runId).toBe(CALLER_RUN_ID)
		// The run the delegate actually opened on disk is the caller's run.
		expect(runDirsOnDisk(cwd)).toEqual([CALLER_RUN_ID])
	})
})

// Current-code invariants asserted (2026-07-13, ses_017):
//
// The composite agents emitted `run_completed` for a run they were themselves reporting
// as CANCELLED — the same lie `ResultAssembler` told for the reactive loop, reinstated one
// layer up. `PipelineAgent` computed `status: 'cancelled'` and then announced a completion
// to every listener in the next statement; `RouterAgent` stamped `run_completed` on top of
// whatever its delegate had come back as, cancellation included. A caller reading the
// RESULT saw the truth; a caller reading the EVENT STREAM — a bridge, a UI, an A2A client —
// did not.
//
//   - A cancelled pipeline emits `run_cancelled`, never `run_completed`.
//   - A router whose delegate was cancelled emits `run_cancelled`, never `run_completed`.
//   - Neither emits `run_failed`: nothing failed, the run was told to stop.
//   - The completed paths are unchanged — `run_completed`, and no `run_cancelled`.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import type {
	Agent,
	AgentInput,
	BaseAgentConfig,
	BaseAgentResult,
	PipelineAgentConfig,
	RouterAgentConfig,
} from '../../types/agent/index.js'
import type { AgentStatus } from '../../types/common/index.js'
import type { ProjectId, RunId, SessionId, TenantId, ThreadId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../types/provider/index.js'
import type { RunEvent } from '../../types/run/index.js'
import { ZERO_COST } from '../../utils/cost.js'
import { PipelineAgent } from '../PipelineAgent.js'
import { RouterAgent } from '../RouterAgent.js'

const RUN_ID = 'run_composite_cancel' as RunId

const USAGE = {
	promptTokens: 10,
	completionTokens: 10,
	totalTokens: 20,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** Answers the router's routing call with a decision naming the one route. */
function routingProvider(): LLMProvider {
	return {
		id: 'fake',
		name: 'Fake',
		async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			return {
				id: 'r',
				model: 'm',
				message: {
					role: 'assistant',
					content: JSON.stringify({ agentId: 'worker', confidence: 1, reasoning: 'it is the one' }),
				},
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

/**
 * A delegate that emits NOTHING and comes back with the status it was built with.
 *
 * Deliberately not a real agent: a real delegate emits its own terminal event under the
 * same run id (a route is a tail call), and the assertion under test is what the ROUTER
 * says on top of it. A silent delegate makes the router's own emission the only terminal
 * on the wire, so the test cannot pass on the delegate's coat-tails.
 */
function silentDelegate(status: AgentStatus): Agent<BaseAgentConfig, BaseAgentResult> {
	return {
		metadata: {
			id: 'worker',
			name: 'worker',
			version: '1.0.0',
			category: 'test',
			description: 'silent delegate',
			type: 'reactive',
			capabilities: {
				supportsTools: false,
				supportsStreaming: false,
				supportsConcurrency: false,
				supportsSubAgents: false,
			},
		},
		async run(): Promise<BaseAgentResult> {
			return {
				runId: RUN_ID,
				status,
				stopReason: status === 'cancelled' ? 'cancelled' : 'end_turn',
				usage: { ...EMPTY_TOKEN_USAGE },
				cost: { ...ZERO_COST },
				iterations: 1,
				durationMs: 1,
				messages: [],
				result: status === 'cancelled' ? undefined : 'delegate did the work',
			}
		},
		async cancel() {},
	} as unknown as Agent<BaseAgentConfig, BaseAgentResult>
}

const workdir = (): string => mkdtempSync(join(tmpdir(), 'namzu-p4-events-'))

function agentInput(signal?: AbortSignal): AgentInput {
	return { messages: [createUserMessage('go')], workingDirectory: workdir(), signal }
}

function typesOf(events: RunEvent[]): string[] {
	return events.map((e) => e.type)
}

describe('PipelineAgent — a cancelled pipeline says so on the wire', () => {
	function pipeline(): PipelineAgent {
		return new PipelineAgent({
			id: 'p1',
			name: 'P1',
			version: '1.0.0',
			category: 'test',
			description: 'test pipeline',
		})
	}

	function config(steps: PipelineAgentConfig['steps']): PipelineAgentConfig {
		return {
			model: 'm',
			tokenBudget: 1_000,
			timeoutMs: 60_000,
			provider: routingProvider(),
			runId: RUN_ID,
			steps,
		}
	}

	it('emits run_cancelled and NOT run_completed', async () => {
		const events: RunEvent[] = []
		const external = new AbortController()

		const result = await pipeline().run(
			agentInput(external.signal),
			config([
				{
					name: 'first',
					execute: async () => {
						external.abort()
						return 'one'
					},
				},
				{ name: 'second', execute: async () => 'two' },
			]),
			(e) => {
				events.push(e)
			},
		)

		expect(result.status).toBe('cancelled')
		expect(typesOf(events)).not.toContain('run_completed')
		expect(typesOf(events)).not.toContain('run_failed')
		expect(events.filter((e) => e.type === 'run_cancelled')).toEqual([
			{ type: 'run_cancelled', runId: RUN_ID },
		])
	})

	it('an uncancelled pipeline still emits run_completed', async () => {
		const events: RunEvent[] = []

		const result = await pipeline().run(
			agentInput(),
			config([{ name: 'only', execute: async () => 'done' }]),
			(e) => {
				events.push(e)
			},
		)

		expect(result.status).toBe('completed')
		expect(typesOf(events)).toContain('run_completed')
		expect(typesOf(events)).not.toContain('run_cancelled')
	})
})

describe('RouterAgent — the router echoes its delegate’s outcome', () => {
	function router(): RouterAgent {
		return new RouterAgent({
			id: 'rt1',
			name: 'RT1',
			version: '1.0.0',
			category: 'test',
			description: 'test router',
		})
	}

	function config(status: AgentStatus): RouterAgentConfig {
		return {
			model: 'm',
			tokenBudget: 1_000,
			timeoutMs: 60_000,
			provider: routingProvider(),
			runId: RUN_ID,
			routes: [{ agentId: 'worker', agent: silentDelegate(status), description: 'does the work' }],
			fallbackAgentId: 'worker',
			maxRoutingRetries: 1,
			invocationState: { tenantId: 'tnt_test' as TenantId },
			sessionId: 'ses_test' as SessionId,
			threadId: 'thr_test' as ThreadId,
			projectId: 'prj_test' as ProjectId,
			tenantId: 'tnt_test' as TenantId,
		}
	}

	it('a cancelled delegate makes the router emit run_cancelled, not run_completed', async () => {
		const events: RunEvent[] = []

		const result = await router().run(agentInput(), config('cancelled'), (e) => {
			events.push(e)
		})

		expect(result.status).toBe('cancelled')
		expect(typesOf(events)).not.toContain('run_completed')
		expect(typesOf(events)).not.toContain('run_failed')
		expect(events.filter((e) => e.type === 'run_cancelled')).toEqual([
			{ type: 'run_cancelled', runId: RUN_ID },
		])
	})

	it('a completed delegate still makes the router emit run_completed', async () => {
		const events: RunEvent[] = []

		const result = await router().run(agentInput(), config('completed'), (e) => {
			events.push(e)
		})

		expect(result.status).toBe('completed')
		expect(typesOf(events)).toContain('run_completed')
		expect(typesOf(events)).not.toContain('run_cancelled')
	})
})

// Current-code invariants asserted (2026-07-12, ses_015 fix-batch):
// - SupervisorAgent composes input.signal with its own abortController (via the
//   base composeRunSignal helper) instead of forwarding the raw input.signal, so
//   supervisor.cancel() ends its OWN in-flight run — the hung provider call is
//   aborted and the run reports 'cancelled', not 'failed'.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProviderRequestError } from '../../provider/errors.js'
import type { TaskGateway } from '../../types/agent/gateway.js'
import type { SupervisorAgentConfig } from '../../types/agent/index.js'
import type { ProjectId, SessionId, TenantId, ThreadId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../types/provider/index.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

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

function baseConfig(provider: LLMProvider): SupervisorAgentConfig {
	return {
		model: 'm',
		tokenBudget: 1_000_000,
		timeoutMs: 600_000,
		maxIterations: 10,
		provider,
		agentIds: [],
		gateway: emptyGateway(),
		systemPrompt: 'You are a supervisor.',
		sessionId: 'ses_test' as SessionId,
		threadId: 'thr_test' as ThreadId,
		projectId: 'prj_test' as ProjectId,
		tenantId: 'tnt_test' as TenantId,
	}
}

function makeAgent(): SupervisorAgent {
	return new SupervisorAgent({
		id: 's1',
		name: 'S1',
		version: '1.0.0',
		category: 'test',
		description: 'test supervisor',
	})
}

describe('SupervisorAgent cancellation', () => {
	it('cancel() ends its own in-flight run as cancelled', async () => {
		const agent = makeAgent()

		const runPromise = agent.run(
			{
				messages: [createUserMessage('coordinate the work')],
				workingDirectory: mkdtempSync(join(tmpdir(), 'namzu-sup-cancel-')),
			},
			baseConfig(hangingProvider()),
		)

		// Let the loop reach the (hanging) provider call, then cancel.
		await new Promise((r) => setTimeout(r, 50))
		await agent.cancel()

		const result = await runPromise
		expect(result.status).toBe('cancelled')
	})
})

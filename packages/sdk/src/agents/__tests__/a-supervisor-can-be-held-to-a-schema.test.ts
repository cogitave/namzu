import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../provider/index.js'
import { ToolRegistry } from '../../registry/index.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/builtins/structuredOutput.js'
import type { SupervisorAgentResult } from '../../types/agent/index.js'
import type { AgentManagerContract } from '../../types/agent/manager.js'
import type { AgentTask, AgentTaskState } from '../../types/agent/task.js'
import type { TaskId } from '../../types/ids/index.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

/**
 * Two archetypes sit on one base and only one could be held to a schema.
 *
 * `ReactiveAgent` has forwarded `structuredOutput` since the field existed;
 * `SupervisorAgentConfig` never declared it, and nothing in that file said
 * why — in a file where every other narrowing carries a paragraph of
 * argument. The kernel path is archetype-blind, so the capability was there
 * the whole time and only the hop was missing.
 *
 * There are TWO hops, and this drives both. The config has to reach
 * `drainQuery` (or `structured_output` is never registered and the model's
 * call comes back an error), and `run.structuredOutput` has to reach the
 * result literal (or the value is produced, recorded, and invisible to the
 * host). `BaseAgentResult.structuredOutput` names the second as a defect it
 * was written to close, and it was still open here.
 */

registerMock()

const VERDICT = z.object({
	verdict: z.enum(['ship', 'hold']),
	reason: z.string(),
})

const ANSWER = { verdict: 'hold' as const, reason: 'the fan-out disagreed with itself' }

/** No children are launched here; the supervisor answers on its own. */
class IdleManager implements AgentManagerContract {
	async sendMessage(): Promise<AgentTask> {
		throw new Error('this supervisor delegates to nobody')
	}
	cancel(): void {}
	async waitForCompletion(): Promise<void> {}
	getInstance(_taskId: TaskId): AgentTask | undefined {
		return undefined
	}
	cancelAll(): void {}
	async continueTask(): Promise<void> {}
	queueMessage(): void {}
	drainMessages() {
		return []
	}
	listByParent(): AgentTask[] {
		return []
	}
	listActive(): AgentTask[] {
		return []
	}
	getState(): AgentTaskState | undefined {
		return undefined
	}
	on(): void {}
	off(): void {}
	cleanup(): void {}
	dispose(): void {}
}

async function supervise(opts: {
	provider: MockLLMProvider
	withSchema: boolean
}): Promise<SupervisorAgentResult> {
	const agent = new SupervisorAgent({
		id: 'sup_schema',
		name: 'Supervisor',
		version: '1',
		category: 'test',
		description: 'coordinates workers',
	})

	return (await agent.run(
		{
			messages: [{ role: 'user', content: 'decide', timestamp: 1 }],
			workingDirectory: await mkdtemp(join(tmpdir(), 'namzu-sup-schema-')),
		} as never,
		{
			provider: opts.provider,
			agentIds: ['worker'],
			agentManager: new IdleManager(),
			tools: new ToolRegistry(),
			systemPrompt: 'You coordinate.',
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 30_000,
			maxIterations: 4,
			sessionId: 'ses_schema',
			threadId: 'thd_schema',
			projectId: 'prj_schema',
			tenantId: 'tnt_schema',
			...(opts.withSchema ? { structuredOutput: { schema: VERDICT } } : {}),
		} as never,
	)) as SupervisorAgentResult
}

describe('a supervisor can be held to a schema', () => {
	it('registers the tool from its own config and hands the value to its caller', async () => {
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: STRUCTURED_OUTPUT_TOOL_NAME, args: ANSWER }] }],
		})

		const result = await supervise({ provider, withSchema: true })

		// The forwarding hop: without it `drainQuery` never registers
		// `structured_output`, the call comes back an error, and nothing is
		// captured. `result` carries the serialization the kernel performs
		// when it records the value, so this fails first and names which hop
		// broke.
		expect(result.result).toBe(JSON.stringify(ANSWER))

		// The result-literal hop: the value exists on the run either way, and
		// this is the surface a supervisor host actually reads.
		expect(result.structuredOutput).toEqual(ANSWER)
	}, 60_000)

	it('holds the supervisor to it — prose is sent back, not accepted', async () => {
		// The demand has to be in force inside the kernel, not merely
		// round-tripped. A model that answers in prose gets the re-prompt, and
		// the answer that counts is the schema-bound one that follows.
		const provider = new MockLLMProvider({
			turns: [
				{ text: 'I think we should hold.' },
				{ toolCalls: [{ name: STRUCTURED_OUTPUT_TOOL_NAME, args: ANSWER }] },
			],
		})

		const result = await supervise({ provider, withSchema: true })

		expect(result.structuredOutput).toEqual(ANSWER)
		expect(result.result).not.toContain('I think we should hold')
	}, 60_000)

	it('changes nothing for a supervisor that was not given a schema', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'plain coordination answer' }] })

		const result = await supervise({ provider, withSchema: false })

		expect(result.structuredOutput).toBeUndefined()
		expect(result.result).toContain('plain coordination answer')
	}, 60_000)
})

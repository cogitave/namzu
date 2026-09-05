import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import { collectChatCompletion } from '../../provider/collect-chat-completion.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { TokenBudget } from '../../run/token-budget.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../types/agent/base.js'
import type { Agent } from '../../types/agent/core.js'
import { ZERO_COST } from '../../utils/cost.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../utils/id.js'
import { PipelineAgent } from '../PipelineAgent.js'
import { RouterAgent } from '../RouterAgent.js'
import { resolveAgentBudget } from '../budget.js'

const directories: string[] = []
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
const metadata = {
	id: 'probe',
	name: 'Probe',
	version: '1',
	category: 'test',
	description: 'accounting probe',
}
const config = { model: 'mock', tokenBudget: 1_000, timeoutMs: 1_000 }
const input = { messages: [], workingDirectory: '/tmp' }

describe('agent budget authority', () => {
	it('opens scoped roots durably and reuses the provided descendant account', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-agent-budget-'))
		directories.push(workingDirectory)
		const scope = {
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
		}
		const runId = generateRunId()
		const budget = await resolveAgentBudget(
			{ ...input, workingDirectory },
			{ ...config, ...scope },
			runId,
		)
		expect(budget.binding?.scope).toEqual({ ...scope, runId })
		const child = budget.reserve(400)
		const childRunId = generateRunId()
		expect(
			await resolveAgentBudget(input, { ...config, budget: child, parentRunId: runId }, childRunId),
		).toBe(child)
		expect(child.runId).toBe(childRunId)
		await budget.flush()
	})

	it('refuses a delegated config that would create a fresh allowance', async () => {
		await expect(
			resolveAgentBudget(input, { ...config, parentRunId: generateRunId() }, generateRunId()),
		).rejects.toThrow('inherited token budget')
	})

	it('meters a pipeline provider and exposes the same authority to descendant callbacks', async () => {
		const provider = new MockLLMProvider({
			turns: [{ text: 'step', usage: { totalTokens: 50, completionTokens: 50 } }],
		})
		const result = await new PipelineAgent(metadata).run(input, {
			...config,
			provider,
			steps: [
				{
					name: 'work',
					async execute(_value, context) {
						await collectChatCompletion(
							context.provider!.chatStream({ model: 'mock', messages: [] }),
						)
						const child = context.budget.reserve(100)
						child.bindRun(generateRunId())
						child.settle(30)
						return 'done'
					},
				},
			],
		})
		expect(result.usage.totalTokens).toBe(50)
		expect(result.budget?.treeTokens).toBe(80)
		expect(result.cost.unpricedTokens).toBe(50)
	})

	it('reserves routing descendants from remaining spend and reports own versus tree usage', async () => {
		let received: BaseAgentConfig | undefined
		const worker: Agent<BaseAgentConfig, BaseAgentResult> = {
			type: 'reactive',
			metadata: {
				...metadata,
				type: 'reactive',
				capabilities: {
					supportsTools: false,
					supportsStreaming: false,
					supportsConcurrency: false,
					supportsSubAgents: false,
				},
			},
			async run(_input, childConfig) {
				received = childConfig
				return {
					runId: generateRunId(),
					status: 'completed',
					usage: {
						...EMPTY_TOKEN_USAGE,
						totalTokens: 500,
						completionTokens: 500,
					},
					cost: { ...ZERO_COST, totalCost: 0.5 },
					iterations: 1,
					durationMs: 1,
					messages: [],
				}
			},
			async cancel() {},
			getCapabilities() {
				return this.metadata.capabilities
			},
		}
		const provider = new MockLLMProvider({
			turns: [
				{
					text: '{"agentId":"worker","confidence":1}',
					usage: { totalTokens: 300, completionTokens: 300 },
				},
			],
		})
		const result = await new RouterAgent(metadata).run(input, {
			...config,
			provider,
			invocationState: { tenantId: generateTenantId() },
			routes: [{ agentId: 'worker', agent: worker, description: 'worker' }],
		})
		expect(received?.budget?.limit).toBe(700)
		expect(received?.parentRunId).toBe(result.runId)
		expect(result.usage.totalTokens).toBe(300)
		expect(result.cost).toMatchObject({ totalCost: 0, unpricedTokens: 300 })
		expect(result.delegateResult.cost.totalCost).toBe(0.5)
		expect(result.budget?.treeTokens).toBe(800)
		expect(result.delegateResult.usage.totalTokens).toBe(500)
	})
})

it('narrows an inherited composite subtree to its explicit numeric cap', async () => {
	const root = TokenBudget.create(1_000, generateRunId())
	const child = root.reserve(500)
	const resolved = await resolveAgentBudget(
		input,
		{ ...config, tokenBudget: 200, budget: child },
		generateRunId(),
	)
	expect(resolved.limit).toBe(200)
	expect(root.remaining).toBe(800)
	expect(() => child.reserve(201)).toThrow()
})

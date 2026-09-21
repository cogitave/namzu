import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { JobTool } from '../../../tools/builtins/job.js'
import { WaitForJobTool } from '../../../tools/builtins/wait-for-job.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { MockTurn } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { BackgroundJobRegistry } from '../../jobs/registry.js'
import { drainQuery } from '../index.js'

/**
 * The same finished job, answered two ways: one `wait_for_job` call, or a
 * poll loop of `job read` / `job list`. Both reach the same answer, but the
 * poll loop spends a full model turn — a full context resend — on every
 * check it makes, and this pins that `wait_for_job` costs fewer of them.
 *
 * This is the regression test for the incident `wait_for_job` exists to
 * fix: research/resident/results/2026-09-14-exploration-policy-terra-tui.json
 * records a live turn that launched one background job, then spent six
 * `job read` polls, three `job list` polls and an improvised `sleep 30`
 * waiting on it — more tokens on the wait than the work it was waiting for
 * cost. `provider.requests.length` is the same unit that incident was
 * measured in: one entry per model turn, each a full context resend.
 */

function startTool() {
	return defineTool({
		name: 'start',
		description: 'starts a short background job',
		inputSchema: z.object({ command: z.string() }),
		category: 'shell',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		execute: async ({ command }, context) => {
			const job = context.backgroundJobs?.start({
				command,
				workingDirectory: context.workingDirectory,
			})
			return { success: true, output: `started ${job?.id ?? 'nothing'}` }
		},
	})
}

function tools(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(startTool())
	registry.register(JobTool)
	registry.register(WaitForJobTool)
	return registry
}

async function run(turns: MockTurn[]) {
	const provider = new MockLLMProvider({ turns })
	const result = await drainQuery({
		provider,
		tools: tools(),
		agentId: 'job-wait-fixture',
		agentName: 'Job wait fixture',
		messages: [{ role: 'user', content: 'start the job and tell me when it finishes' }],
		workingDirectory: process.cwd(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		turnConfig: { model: 'mock', maxIterations: 8, tokenBudget: 200_000, timeoutMs: 20_000 },
		backgroundJobs: new BackgroundJobRegistry(),
	})
	return { result, provider }
}

// A fresh registry per run always hands out `job_1` first, so the scripted
// model can name the id before the tool call that creates it returns.
const START = { toolCalls: [{ id: 'c1', name: 'start', args: { command: 'true' } }] }
const DONE = { text: 'done' }

describe('wait_for_job costs fewer provider requests than polling for the same job', () => {
	it('resolves a finished job in one wait_for_job call', async () => {
		const { result, provider } = await run([
			START,
			{ toolCalls: [{ id: 'c2', name: 'wait_for_job', args: { id: 'job_1' } }] },
			DONE,
		])
		expect(result.status).toBe('completed')
		expect(provider.requests.length).toBe(3)
	})

	it('costs one provider request per check when the model polls instead', async () => {
		const { result, provider } = await run([
			START,
			{ toolCalls: [{ id: 'c2', name: 'job', args: { action: 'read', id: 'job_1' } }] },
			{ toolCalls: [{ id: 'c3', name: 'job', args: { action: 'read', id: 'job_1' } }] },
			{ toolCalls: [{ id: 'c4', name: 'job', args: { action: 'list' } }] },
			DONE,
		])
		expect(result.status).toBe('completed')
		expect(provider.requests.length).toBe(5)
	})

	it('spends strictly fewer provider requests waiting than polling for the same job', async () => {
		const waiting = await run([
			START,
			{ toolCalls: [{ id: 'c2', name: 'wait_for_job', args: { id: 'job_1' } }] },
			DONE,
		])
		const polling = await run([
			START,
			{ toolCalls: [{ id: 'c2', name: 'job', args: { action: 'read', id: 'job_1' } }] },
			{ toolCalls: [{ id: 'c3', name: 'job', args: { action: 'read', id: 'job_1' } }] },
			{ toolCalls: [{ id: 'c4', name: 'job', args: { action: 'list' } }] },
			DONE,
		])
		expect(waiting.provider.requests.length).toBeLessThan(polling.provider.requests.length)
	})
})

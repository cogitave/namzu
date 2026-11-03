import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { drainQuery } from '../index.js'

/**
 * A model chosen while a reply is running is used by the next request in the
 * same tool loop, never by the request already in flight.
 *
 * The host expresses it through `prepareStep`, which is prepared from scratch
 * before every request: reading a live pick there is the whole mechanism, and
 * this pins that the loop honours it request by request.
 */

let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

async function mkWorkdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-model-pick-'))
	workdirs.push(dir)
	return dir
}

async function params(provider: MockLLMProvider, tools: ToolDefinition[]) {
	return {
		provider,
		toolsets: [testToolset(...tools)],
		turnConfig: {
			model: 'first-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 6,
			maxResponseTokens: 256,
		},
		agentId: 'agent_pick',
		agentName: 'Model Pick Agent',
		workingDirectory: await mkWorkdir(),
		sessionId: 'd94e5f40-5557-4759-8d09-9be378798204' as SessionId,
		topicId: 'fbf3f27e-0f92-44eb-b923-22b41a1675e1' as TopicId,
		projectId: 'd89c57c3-daaf-417e-9374-a35c9c58c430' as ProjectId,
		tenantId: 'e05c6f07-df73-4784-a299-9377c74774fd' as TenantId,
		messages: [createUserMessage('go')],
	}
}

describe('a model picked mid-reply', () => {
	it('is used from the next request of the same tool loop', async () => {
		let pick: string | undefined
		const tools: ToolDefinition[] = [
			{
				name: 'echo',
				description: 'Echo the text back.',
				inputSchema: z.object({}),
				// The operator picks while the first request's tool call runs.
				execute: async () => {
					pick = 'second-model'
					return { success: true, output: 'ok' }
				},
			},
		]
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] },
				{ toolCalls: [{ id: 'c2', name: 'echo', rawArguments: '{}' }] },
				{ text: 'finished' },
			],
		})

		await drainQuery({
			...(await params(provider, tools)),
			prepareStep: () => (pick ? { model: pick } : undefined),
		})

		expect(provider.requests.map((request) => request.model)).toEqual([
			'first-model',
			'second-model',
			'second-model',
		])
	})

	it('leaves every request on the turn model when nothing was picked', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'echo',
				description: 'Echo the text back.',
				inputSchema: z.object({}),
				execute: async () => ({ success: true, output: 'ok' }),
			},
		]
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] }, { text: 'done' }],
		})

		await drainQuery({
			...(await params(provider, tools)),
			prepareStep: () => undefined,
		})

		expect(provider.requests.map((request) => request.model)).toEqual([
			'first-model',
			'first-model',
		])
	})
})

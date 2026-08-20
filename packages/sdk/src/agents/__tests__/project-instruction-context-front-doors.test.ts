import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import type { ProjectInstructionContext } from '../../runtime/query/project-instructions.js'
import type { ReactiveAgentConfig } from '../../types/agent/reactive.js'
import type { SupervisorAgentConfig } from '../../types/agent/supervisor.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import {
	type Message,
	createProjectInstructionMessage,
	createUserMessage,
} from '../../types/message/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { ReactiveAgent } from '../ReactiveAgent.js'
import { SupervisorAgent } from '../SupervisorAgent.js'
import { runAgent } from '../runAgent.js'

const scope = {
	sessionId: 'ses_project_front' as SessionId,
	topicId: 'top_project_front' as TopicId,
	projectId: 'prj_project_front' as ProjectId,
	tenantId: 'tnt_project_front' as TenantId,
}

function controller(): ProjectInstructionContext {
	return {
		prepareInitialSnapshot: () =>
			createProjectInstructionMessage('front-door policy sentinel', ['AGENTS.md']),
		observeToolResult: () => {},
		takeSnapshotUpdate: () => undefined,
	}
}

function expectPolicy(provider: MockLLMProvider): void {
	const messages = provider.requests[0]?.messages as readonly Message[] | undefined
	expect(
		messages?.some(
			(message) =>
				message.role === 'user' &&
				message.source?.type === 'project-instructions' &&
				message.content === 'front-door policy sentinel',
		),
	).toBe(true)
}

describe('agent front doors preserve live project policy', () => {
	let dirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(dirs)
		dirs = []
	})

	async function directory(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-project-front-'))
		dirs.push(dir)
		return dir
	}

	it('runAgent forwards the controller into the first provider request', async () => {
		const provider = new MockLLMProvider({ responseText: 'done' })

		await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'work',
			workingDirectory: await directory(),
			projectInstructionContext: controller(),
			...scope,
		})

		expectPolicy(provider)
	})

	it('ReactiveAgent forwards the controller into the first provider request', async () => {
		const provider = new MockLLMProvider({ responseText: 'done' })
		const agent = new ReactiveAgent({
			id: 'reactive-project-front',
			name: 'Reactive Project Front',
			version: '1',
			category: 'test',
			description: 'project-policy reachability probe',
		})
		const config = {
			provider,
			tools: new ToolRegistry(),
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			maxIterations: 1,
			projectInstructionContext: controller(),
			...scope,
		} satisfies ReactiveAgentConfig

		await agent.run(
			{
				messages: [createUserMessage('work')],
				workingDirectory: await directory(),
			},
			config,
		)

		expectPolicy(provider)
	})

	it('SupervisorAgent forwards the controller into the first provider request', async () => {
		const provider = new MockLLMProvider({ responseText: 'done' })
		const agent = new SupervisorAgent({
			id: 'supervisor-project-front',
			name: 'Supervisor Project Front',
			version: '1',
			category: 'test',
			description: 'project-policy reachability probe',
		})
		const config = {
			provider,
			agentIds: [],
			allowDelegation: false,
			agentManager: { sendMessage: async () => ({}) } as never,
			systemPrompt: 'Answer directly.',
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			maxIterations: 1,
			projectInstructionContext: controller(),
			...scope,
		} satisfies SupervisorAgentConfig

		await agent.run(
			{
				messages: [createUserMessage('work')],
				workingDirectory: await directory(),
			},
			config,
		)

		expectPolicy(provider)
	})
})

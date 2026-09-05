import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import type { ReactiveAgentConfig } from '../../types/agent/reactive.js'
import type { SupervisorAgentConfig } from '../../types/agent/supervisor.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import { type UserMessage, createUserMessage } from '../../types/message/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { ReactiveAgent } from '../ReactiveAgent.js'
import { SupervisorAgent } from '../SupervisorAgent.js'
import { runAgent } from '../runAgent.js'

const scope = {
	sessionId: '3cdbce22-edce-4f36-aec7-644f29f72a87' as SessionId,
	topicId: 'd3df3586-e05b-4c3c-9e82-9381af89004f' as TopicId,
	projectId: '1ec83217-ec48-42c8-acfb-0a37c43c4872' as ProjectId,
	tenantId: '46200af0-33d2-4831-89b5-dfa19e427570' as TenantId,
}

const image = { data: 'A'.repeat(8), mediaType: 'image/png' }
const prompt = () => createUserMessage('inspect this', [image])

function expectProjected(provider: MockLLMProvider): void {
	const sent = provider.requests[0]?.messages.find(
		(message): message is UserMessage =>
			message.role === 'user' && message.content.startsWith('inspect this'),
	)
	expect(sent?.attachments).toBeUndefined()
	expect(sent?.content).toContain('image omitted')
}

describe('agent front doors preserve the request rich-content budget', () => {
	let dirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(dirs)
		dirs = []
	})

	async function directory(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-rich-front-'))
		dirs.push(dir)
		return dir
	}

	it('runAgent forwards it into the query run config', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })

		await runAgent({
			provider,
			model: 'mock-model',
			prompt: [prompt()],
			workingDirectory: await directory(),
			maxRequestRichContentBytes: 1,
			...scope,
		})

		expectProjected(provider)
	})

	it('ReactiveAgent forwards it into the query run config', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const workingDirectory = await directory()
		const agent = new ReactiveAgent({
			id: 'reactive-rich-front',
			name: 'Reactive Rich Front',
			version: '1',
			category: 'test',
			description: 'request budget reachability probe',
		})
		const config = {
			provider,
			tools: new ToolRegistry(),
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			maxRequestRichContentBytes: 1,
			maxIterations: 1,
			...scope,
		} satisfies ReactiveAgentConfig

		await agent.run({ messages: [prompt()], workingDirectory }, config)

		expectProjected(provider)
	})

	it('SupervisorAgent forwards it into the query run config', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const workingDirectory = await directory()
		const agent = new SupervisorAgent({
			id: 'supervisor-rich-front',
			name: 'Supervisor Rich Front',
			version: '1',
			category: 'test',
			description: 'request budget reachability probe',
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
			maxRequestRichContentBytes: 1,
			maxIterations: 1,
			...scope,
		} satisfies SupervisorAgentConfig

		await agent.run({ messages: [prompt()], workingDirectory }, config)

		expectProjected(provider)
	})
})

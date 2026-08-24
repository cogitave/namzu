import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import {
	type AttachmentOperationOptions,
	AttachmentResolutionTimeoutError,
	type AttachmentStore,
} from '../../store/attachment/index.js'
import type { ReactiveAgentConfig } from '../../types/agent/reactive.js'
import type { SupervisorAgentConfig } from '../../types/agent/supervisor.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import {
	type Message,
	type MessageAttachment,
	createUserMessage,
} from '../../types/message/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { ReactiveAgent } from '../ReactiveAgent.js'
import { SupervisorAgent } from '../SupervisorAgent.js'
import { runAgent } from '../runAgent.js'

const scope = {
	sessionId: 'ses_attachment_front' as SessionId,
	topicId: 'top_attachment_front' as TopicId,
	projectId: 'prj_attachment_front' as ProjectId,
	tenantId: 'tnt_attachment_front' as TenantId,
}

function prompt(): Message {
	const attachment = {
		type: 'stored',
		ref: 'ref_front_door',
		kind: 'document',
		mediaType: 'application/pdf',
		name: 'front-door.pdf',
	} as unknown as MessageAttachment
	return {
		...createUserMessage('read the stored document'),
		attachments: [attachment],
	}
}

function nonCooperativeStore(): {
	readonly store: AttachmentStore
	readonly calls: () => number
	readonly signal: () => AbortSignal | undefined
} {
	let calls = 0
	let signal: AbortSignal | undefined
	return {
		store: {
			put: async () => 'unused',
			get: (_ref: string, options?: AttachmentOperationOptions) => {
				calls += 1
				signal = options?.signal
				return new Promise<never>(() => undefined)
			},
		},
		calls: () => calls,
		signal: () => signal,
	}
}

async function expectBounded(
	caller: AbortController,
	store: ReturnType<typeof nonCooperativeStore>,
	provider: MockLLMProvider,
	operation: Promise<unknown>,
): Promise<void> {
	const safety = setTimeout(
		() => caller.abort(new Error('test safety bound: attachment policy was not forwarded')),
		1_000,
	)
	let error: unknown
	try {
		await operation
	} catch (caught) {
		error = caught
	} finally {
		clearTimeout(safety)
	}

	expect(error).toBeInstanceOf(AttachmentResolutionTimeoutError)
	expect(error).toMatchObject({ details: { timeoutMs: 20 } })
	expect(store.calls()).toBe(1)
	expect(store.signal()?.aborted).toBe(true)
	expect(store.signal()?.reason).toBe(error)
	expect(provider.requests).toHaveLength(0)
	expect(caller.signal.aborted).toBe(false)
}

describe('agent front doors own stored attachment liveness', () => {
	const dirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(dirs)
		dirs.length = 0
	})

	async function workingDirectory(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-attachment-front-'))
		dirs.push(dir)
		return dir
	}

	it('runAgent forwards both the store and its deadline', async () => {
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const store = nonCooperativeStore()
		const caller = new AbortController()

		await expectBounded(
			caller,
			store,
			provider,
			runAgent({
				provider,
				model: 'mock-model',
				prompt: [prompt()],
				workingDirectory: await workingDirectory(),
				attachmentStore: store.store,
				attachmentResolveTimeoutMs: 20,
				signal: caller.signal,
				...scope,
			}),
		)
	})

	it('ReactiveAgent forwards both the store and its deadline', async () => {
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const store = nonCooperativeStore()
		const caller = new AbortController()
		const agent = new ReactiveAgent({
			id: 'reactive-attachment-front',
			name: 'Reactive Attachment Front',
			version: '1',
			category: 'test',
			description: 'stored attachment reachability probe',
		})
		const config = {
			provider,
			tools: new ToolRegistry(),
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			attachmentResolveTimeoutMs: 20,
			maxIterations: 1,
			...scope,
		} satisfies ReactiveAgentConfig

		await expectBounded(
			caller,
			store,
			provider,
			agent.run(
				{
					messages: [prompt()],
					workingDirectory: await workingDirectory(),
					attachmentStore: store.store,
					signal: caller.signal,
				},
				config,
			),
		)
	})

	it('SupervisorAgent forwards both the store and its deadline', async () => {
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const store = nonCooperativeStore()
		const caller = new AbortController()
		const agent = new SupervisorAgent({
			id: 'supervisor-attachment-front',
			name: 'Supervisor Attachment Front',
			version: '1',
			category: 'test',
			description: 'stored attachment reachability probe',
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
			attachmentResolveTimeoutMs: 20,
			maxIterations: 1,
			...scope,
		} satisfies SupervisorAgentConfig

		await expectBounded(
			caller,
			store,
			provider,
			agent.run(
				{
					messages: [prompt()],
					workingDirectory: await workingDirectory(),
					attachmentStore: store.store,
					signal: caller.signal,
				},
				config,
			),
		)
	})
})

import { describe, expect, it } from 'vitest'

import { MockLLMProvider } from '../../provider/mock.js'
import { InMemorySessionLog } from '../../store/session-log/index.js'
import type {
	AgentInvocationScope,
	ManagedAgentInput,
	QueryAgentConfig,
} from '../../types/agent/index.js'
import { createUserMessage } from '../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../utils/id.js'
import { QueryAgent } from '../QueryAgent.js'
import { ConcurrentInvocationError } from '../lock.js'

function managedScope(): AgentInvocationScope {
	return {
		kind: 'managed',
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		projectId: generateProjectId(),
		tenantId: generateTenantId(),
	}
}

function agent(): QueryAgent {
	return new QueryAgent({
		type: 'test-query',
		id: 'test-query',
		name: 'Test Query',
		version: '1',
		category: 'test',
		description: 'tests invocation-owned scope',
	})
}

function input(managedScope?: AgentInvocationScope): ManagedAgentInput {
	return {
		messages: [createUserMessage('hello')],
		workingDirectory: process.cwd(),
		...(managedScope ? { managedScope } : {}),
	}
}

function config(
	provider: MockLLMProvider,
	sessionId: AgentInvocationScope['sessionId'],
): QueryAgentConfig {
	return {
		provider,
		toolsets: [],
		model: 'mock-model',
		tokenBudget: 1_000,
		timeoutMs: 5_000,
		sessionLog: new InMemorySessionLog({ sessionId }),
	}
}

describe('QueryAgent invocation scope', () => {
	it('runs from the host-owned managed scope without identity in reusable config', async () => {
		const scope = managedScope()
		const provider = new MockLLMProvider({ responseText: 'ready' })
		const sessionLog = new InMemorySessionLog({ sessionId: scope.sessionId })
		const turn = await agent().run(input(scope), {
			...config(provider, scope.sessionId),
			sessionLog,
		})

		expect(turn.status).toBe('completed')
		expect(turn.sessionId).toBe(scope.sessionId)
		expect(provider.requests).toHaveLength(1)
		expect((await sessionLog.readAll()).entries[0]?.record).toMatchObject({
			type: 'session_started',
			projectId: scope.projectId,
			topicId: scope.topicId,
			tenantId: scope.tenantId,
		})
	})

	it('keeps a complete legacy config working when no invocation scope is supplied', async () => {
		const scope = managedScope()
		const provider = new MockLLMProvider({ responseText: 'ready' })
		const turn = await agent().run(input(), {
			...config(provider, scope.sessionId),
			sessionId: scope.sessionId,
			topicId: scope.topicId,
			projectId: scope.projectId,
			tenantId: scope.tenantId,
		})

		expect(turn.status).toBe('completed')
		expect(turn.sessionId).toBe(scope.sessionId)
	})

	it.each(['sessionId', 'topicId', 'projectId', 'tenantId'] as const)(
		'refuses a conflicting legacy %s before the model is called',
		async (field) => {
			const scope = managedScope()
			const wrong = managedScope()
			const provider = new MockLLMProvider({ responseText: 'must not run' })
			await expect(
				agent().run(input(scope), {
					...config(provider, scope.sessionId),
					[field]: wrong[field],
				}),
			).rejects.toThrow(field)
			expect(provider.requests).toHaveLength(0)
		},
	)

	it('refuses an incomplete legacy scope instead of minting missing IDs', async () => {
		const scope = managedScope()
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		await expect(
			agent().run(input(), {
				...config(provider, scope.sessionId),
				sessionId: scope.sessionId,
			}),
		).rejects.toThrow(/requires sessionId, topicId, projectId, and tenantId/)
		expect(provider.requests).toHaveLength(0)
	})

	it('refuses a partial managed scope before the model or recorder starts', async () => {
		const scope = managedScope()
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		await expect(
			agent().run(
				input({ ...scope, tenantId: undefined } as unknown as AgentInvocationScope),
				config(provider, scope.sessionId),
			),
		).rejects.toThrow(/input\.managedScope is missing: tenantId/)
		expect(provider.requests).toHaveLength(0)
	})

	it('refuses a scope of another kind instead of treating it as managed', async () => {
		const scope = managedScope()
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		await expect(
			agent().run(
				input({ ...scope, kind: 'local' } as unknown as AgentInvocationScope),
				config(provider, scope.sessionId),
			),
		).rejects.toThrow(/managed invocation scope/)
		expect(provider.requests).toHaveLength(0)
	})

	it('refuses null scope even when legacy config is complete', async () => {
		const scope = managedScope()
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		await expect(
			agent().run(
				{ ...input(), managedScope: null as never },
				{
					...config(provider, scope.sessionId),
					sessionId: scope.sessionId,
					topicId: scope.topicId,
					projectId: scope.projectId,
					tenantId: scope.tenantId,
				},
			),
		).rejects.toThrow(/managed invocation scope/)
		expect(provider.requests).toHaveLength(0)
	})

	it('still joins a retry under the same managed scope and key', async () => {
		const scope = managedScope()
		const provider = new MockLLMProvider({ responseDelayMs: 100, responseText: 'ready' })
		const shell = agent()
		const settings = { ...config(provider, scope.sessionId), idempotencyKey: 'request-1' }
		const first = shell.run(input(scope), settings)
		const retry = shell.run(input(scope), settings)
		const [one, two] = await Promise.all([first, retry])

		expect(two.turnId).toBe(one.turnId)
		expect(provider.requests).toHaveLength(1)
	})

	it.each(['sessionId', 'topicId', 'projectId', 'tenantId'] as const)(
		'does not share an in-flight result when %s differs under the same raw key',
		async (field) => {
			const firstScope = managedScope()
			const otherScope = managedScope()
			const secondScope = { ...firstScope, [field]: otherScope[field] }
			const provider = new MockLLMProvider({ responseDelayMs: 100, responseText: 'ready' })
			const shell = agent()
			const first = shell.run(input(firstScope), {
				...config(provider, firstScope.sessionId),
				idempotencyKey: 'request-1',
			})
			const other = shell
				.run(input(secondScope), {
					...config(provider, secondScope.sessionId),
					idempotencyKey: 'request-1',
				})
				.catch((error: unknown) => error)

			expect(await other).toBeInstanceOf(ConcurrentInvocationError)
			expect((await first).sessionId).toBe(firstScope.sessionId)
			expect(provider.requests).toHaveLength(1)
		},
	)

	it('validates scope before joining an in-flight call with the same key', async () => {
		const scope = managedScope()
		const provider = new MockLLMProvider({ responseDelayMs: 100, responseText: 'ready' })
		const shell = agent()
		const settings = { ...config(provider, scope.sessionId), idempotencyKey: 'request-1' }
		const first = shell.run(input(scope), settings)
		const invalid = shell
			.run(input({ ...scope, tenantId: undefined } as unknown as AgentInvocationScope), settings)
			.catch((error: unknown) => error)

		const failure = await invalid
		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toMatch(/input\.managedScope is missing: tenantId/)
		await first
		expect(provider.requests).toHaveLength(1)
	})
})

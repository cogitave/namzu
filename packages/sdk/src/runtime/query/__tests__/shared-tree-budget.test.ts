import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { SessionEvent, Turn } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs.splice(0))
})
const usage = (tokens: number) => ({
	promptTokens: tokens,
	completionTokens: 0,
	totalTokens: tokens,
})

describe('query shares one allowance with descendant model work', () => {
	it('stops the parent on total tree spend while preserving its own usage separately', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-tree-budget-'))
		dirs.push(workingDirectory)
		const turnId = generateTurnId()
		const scope = {
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
		}
		const budget = SessionTokenBudget.create(1_000, {
			rootSessionId: scope.sessionId,
			rootTurnId: turnId,
		})
		const childProvider = new MockLLMProvider({
			turns: [{ text: 'child done', usage: usage(200) }],
		})
		const parentProvider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'child-1', name: 'delegate', args: {} }], usage: usage(800) },
				{ text: 'must not make this request', usage: usage(50) },
			],
		})
		let child: Turn | undefined
		const tools = testToolset({
			name: 'delegate',
			description: 'Delegate bounded work',
			inputSchema: z.object({}),
			execute: async () => {
				expect(budget.remaining).toBe(200)
				expect(() => budget.reserve(500)).toThrow()
				const childBudget = budget.reserve(100)
				child = await drainQuery({
					...scope,
					sessionId: generateSessionId(),
					turnId: generateTurnId(),
					parentSessionId: scope.sessionId,
					parentTurnId: turnId,
					budget: childBudget,
					provider: childProvider,
					toolsets: [],
					retry: false,
					agentId: 'child',
					agentName: 'Child',
					workingDirectory,
					turnConfig: { model: 'mock', tokenBudget: 100, timeoutMs: 30_000, maxIterations: 2 },
					messages: [createUserMessage('Do the child work.')],
				})
				childBudget.settle(child.tokenUsage.totalTokens)
				return { success: true, output: child.result ?? 'child completed' }
			},
		})
		const events: SessionEvent[] = []
		const parent = await drainQuery(
			{
				...scope,
				turnId,
				budget,
				provider: parentProvider,
				toolsets: [tools],
				retry: false,
				agentId: 'parent',
				agentName: 'Parent',
				workingDirectory,
				turnConfig: { model: 'mock', tokenBudget: 1_000, timeoutMs: 30_000, maxIterations: 3 },
				messages: [createUserMessage('Delegate work, then report.')],
			},
			(event) => {
				events.push(event)
			},
		)
		expect(parentProvider.requests).toHaveLength(1)
		expect(childProvider.requests).toHaveLength(1)
		expect(parent.stopReason).toBe('token_budget')
		expect(parent.tokenUsage.totalTokens).toBe(800)
		expect(child?.tokenUsage.totalTokens).toBe(200)
		expect(parent.budget).toMatchObject({
			ownTokens: 800,
			treeTokens: 1_000,
			remainingTokens: 0,
			reservedTokens: 0,
		})
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'turn_completed', stopReason: 'token_budget' }),
		)
	})

	it('accounts for completed usage even when the event consumer throws', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-tree-budget-failure-'))
		dirs.push(workingDirectory)
		const turnId = generateTurnId()
		const sessionId = generateSessionId()
		const budget = SessionTokenBudget.create(1_000, {
			rootSessionId: sessionId,
			rootTurnId: turnId,
		})
		const provider = new MockLLMProvider({ turns: [{ text: 'done', usage: usage(300) }] })
		const result = drainQuery(
			{
				turnId,
				budget,
				provider,
				toolsets: [],
				retry: false,
				workingDirectory,
				projectId: generateProjectId(),
				sessionId,
				topicId: generateTopicId(),
				tenantId: generateTenantId(),
				agentId: 'one',
				agentName: 'One',
				turnConfig: { model: 'mock', tokenBudget: 1_000, timeoutMs: 30_000, maxIterations: 2 },
				messages: [createUserMessage('Finish.')],
			},
			(event) => {
				if (event.type === 'token_usage_updated') throw new Error('observer failed')
			},
		)
		await expect(result).rejects.toThrow('observer failed')
		expect(provider.requests).toHaveLength(1)
		expect(budget.ownTokens).toBe(300)
	})
})

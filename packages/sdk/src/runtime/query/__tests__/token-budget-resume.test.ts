import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { TokenBudget } from '../../../run/token-budget.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { DiskTokenBudgetStore, openTokenBudget } from '../../../store/run/token-budget-disk.js'
import type { TokenUsage } from '../../../types/common/index.js'
import { type IterationCheckpoint, autoApproveHandler } from '../../../types/hitl/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { TokenBudgetScope } from '../../../types/run/token-budget-store.js'
import { ZERO_COST } from '../../../utils/cost.js'
import {
	generateCheckpointId,
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type ResumeRunParams, resumeRun } from '../resume-run.js'
import type { RunStateScope } from '../run-state.js'
import { resolveQueryBudget } from '../token-budget.js'

const directories: string[] = []
afterEach(async () => {
	await removeTempDirs(directories.splice(0))
})

function usage(tokens: number): TokenUsage {
	return {
		promptTokens: tokens,
		completionTokens: 0,
		totalTokens: tokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

async function fixture() {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-ledger-resume-'))
	directories.push(workingDirectory)
	const rootScope: TokenBudgetScope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		runId: generateRunId(),
	}
	const store = new DiskTokenBudgetStore({ baseDir: join(workingDirectory, 'ledgers') })
	const root = await openTokenBudget({ store, scope: rootScope, limit: 1_000 })
	const scope: RunStateScope = { ...rootScope, topicId: generateTopicId() }
	const checkpointStore = new InMemoryCheckpointStore()
	const provider = new MockLLMProvider({ turns: [{ text: 'continued', usage: usage(50) }] })
	const params: ResumeRunParams = {
		...scope,
		scope,
		provider,
		tools: new ToolRegistry(),
		resumeHandler: autoApproveHandler,
		checkpointStore,
		tokenBudgetStore: new DiskTokenBudgetStore({ baseDir: join(workingDirectory, 'ledgers') }),
		workingDirectory,
		retry: false,
		agentId: 'resume-budget',
		agentName: 'Resume budget',
		runConfig: { model: 'mock', timeoutMs: 30_000, tokenBudget: 1_000, maxIterations: 4 },
	}
	return { workingDirectory, rootScope, root, store, scope, checkpointStore, provider, params }
}

function checkpoint(
	budget: TokenBudget,
	scope: RunStateScope,
	tokens: number,
): IterationCheckpoint {
	return {
		id: generateCheckpointId(),
		runId: scope.runId,
		iteration: 1,
		messages: [createUserMessage('Continue the saved work.')],
		tokenUsage: usage(tokens),
		costInfo: { ...ZERO_COST },
		guardState: { iterationCount: 1, elapsedMs: 1 },
		createdAt: Date.now(),
		budgetBinding: budget.binding,
		budgetAccountId: budget.accountId,
	}
}

describe('checkpoint resume keeps the latest token authority', () => {
	it('applies a narrower run cap to a supplied root authority', async () => {
		const f = await fixture()
		const resolved = await resolveQueryBudget(
			{
				...f.params,
				budget: f.root,
				messages: [],
				runConfig: { ...f.params.runConfig, tokenBudget: 100 },
			},
			f.scope.runId,
		)
		await resolved.flush()
		expect(resolved).toBe(f.root)
		expect(resolved.limit).toBe(100)
		const reopened = await openTokenBudget({
			store: f.store,
			scope: f.rootScope,
			requireExisting: true,
		})
		expect(reopened.limit).toBe(100)
	})

	it('restores old root messages without rolling back newer parent or child spending', async () => {
		const f = await fixture()
		f.root.recordUsage(usage(100))
		await f.checkpointStore.writeCheckpoint(f.scope, checkpoint(f.root, f.scope, 100))
		f.root.recordUsage(usage(300))
		const child = f.root.reserve(400)
		child.bindRun(generateRunId())
		child.recordUsage(usage(200))
		child.settle()
		await f.root.flush()
		const outcome = await resumeRun(f.params)
		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) throw new Error('resume unexpectedly refused')
		expect(f.provider.requests).toHaveLength(1)
		expect(outcome.run.tokenUsage.totalTokens).toBe(350)
		expect(outcome.run.budget?.treeTokens).toBe(550)
		const reopened = await openTokenBudget({
			store: f.store,
			scope: f.rootScope,
			requireExisting: true,
		})
		expect(reopened.ownTokens).toBe(350)
		expect(reopened.treeTokens).toBe(550)
	})

	it('reopens a child against its root ledger and original child grant', async () => {
		const f = await fixture()
		f.root.recordUsage(usage(200))
		const child = f.root.reserve(400)
		const childScope = {
			...f.scope,
			sessionId: generateSessionId(),
			runId: generateRunId(),
			parentRunId: f.rootScope.runId,
		}
		child.bindRun(childScope.runId)
		child.recordUsage(usage(100))
		await f.checkpointStore.writeCheckpoint(childScope, checkpoint(child, childScope, 100))
		child.recordUsage(usage(250))
		await f.root.flush()
		const outcome = await resumeRun({
			...f.params,
			...childScope,
			scope: childScope,
			runConfig: { ...f.params.runConfig, tokenBudget: 400 },
		})
		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) throw new Error('resume unexpectedly refused')
		expect(f.provider.requests).toHaveLength(1)
		expect(outcome.run.tokenUsage.totalTokens).toBe(300)
		const reopened = await openTokenBudget({
			store: f.store,
			scope: f.rootScope,
			requireExisting: true,
		})
		expect(reopened.ownTokens).toBe(200)
		expect(reopened.treeTokens).toBe(500)
	})

	it('makes no provider call when newer durable spending already exhausts the root', async () => {
		const f = await fixture()
		await f.checkpointStore.writeCheckpoint(f.scope, checkpoint(f.root, f.scope, 100))
		f.root.recordUsage(usage(1_000))
		await f.root.flush()
		const outcome = await resumeRun(f.params)
		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) throw new Error('resume unexpectedly refused')
		expect(f.provider.requests).toHaveLength(0)
		expect(outcome.run.stopReason).toBe('token_budget')
		expect(outcome.run.tokenUsage.totalTokens).toBe(1_000)
	})

	it('requires current authority for a checkpoint made with an in-memory account', async () => {
		const f = await fixture()
		const current = TokenBudget.create(1_000, f.scope.runId)
		current.recordUsage(usage(150))
		await f.checkpointStore.writeCheckpoint(f.scope, checkpoint(current, f.scope, 100))
		await expect(resumeRun(f.params)).rejects.toThrow('current authoritative budget')
		expect(f.provider.requests).toHaveLength(0)
		const result = await resumeRun({ ...f.params, budget: current })
		expect(result.resumed).toBe(true)
		expect(current.ownTokens).toBe(200)
	})

	it('refuses copied account identity from a different root scope before spending', async () => {
		const f = await fixture()
		await f.checkpointStore.writeCheckpoint(f.scope, checkpoint(f.root, f.scope, 0))
		const copied = TokenBudget.restore(f.root.snapshot(), {
			scope: { ...f.rootScope, sessionId: generateSessionId() },
			save: async () => {},
		})
		await expect(resumeRun({ ...f.params, budget: copied })).rejects.toThrow('root scope')
		expect(f.provider.requests).toHaveLength(0)
	})

	it('does not create a ledger while resolving a missing checkpoint', async () => {
		const f = await fixture()
		const runId = generateRunId()
		const queryParams = {
			...f.params,
			runId,
			messages: [],
			resumeFromCheckpoint: generateCheckpointId(),
		}
		await expect(resolveQueryBudget(queryParams, runId)).rejects.toThrow('missing checkpoint')
		expect(await f.store.load({ ...f.rootScope, runId })).toBeNull()
		expect(f.provider.requests).toHaveLength(0)
	})
})

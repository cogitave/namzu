import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import {
	type CheckpointScope,
	InMemorySessionCheckpointStore,
} from '../../../store/checkpoint/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { CheckpointId } from '../../../types/hitl/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { checkpointLogView } from '../session-storage.js'

/**
 * Checkpoint retention is housekeeping, and housekeeping does not end a turn.
 *
 * With retention on by default in the CLI, a prune runs after every
 * iteration's checkpoint. A prune that throws — a store that cannot delete, a
 * history it refuses to collect around — used to propagate out of the
 * iteration and fail the live turn over disk it could reclaim next time.
 */

registerMock()

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

class RefusingPruneStore extends InMemorySessionCheckpointStore {
	prunes = 0
	override async prune(_scope: CheckpointScope, _keepLast: number): Promise<CheckpointId[]> {
		this.prunes += 1
		throw new Error('disk says no')
	}
}

class CountingPruneStore extends InMemorySessionCheckpointStore {
	pruned: CheckpointId[] = []
	override async prune(scope: CheckpointScope, keepLast: number): Promise<CheckpointId[]> {
		const removed = await super.prune(scope, keepLast)
		this.pruned.push(...removed)
		return removed
	}
}

async function run(
	makeStore: (log: InMemorySessionLog) => InMemorySessionCheckpointStore,
): Promise<{
	result: Awaited<ReturnType<typeof drainQuery>>
	store: InMemorySessionCheckpointStore
}> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-retention-'))
	dirs.push(root)
	const tools = testToolset({
		name: 'probe',
		description: 'probe',
		inputSchema: z.object({ n: z.number() }),
		isReadOnly: () => true,
		execute: async ({ n }) => ({ success: true, output: `probed ${n}` }),
	})
	const turns = Array.from({ length: 4 }, (_, n) => ({
		toolCalls: [{ id: `c${n}`, name: 'probe', args: { n } }],
	}))
	const sessionId = generateSessionId()
	const sessionLog = new InMemorySessionLog({ sessionId })
	const store = makeStore(sessionLog)
	const result = await drainQuery({
		provider: new MockLLMProvider({ turns: [...turns, { text: 'done' }] }),
		toolsets: [tools],
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'probe four times' }],
		workingDirectory: root,
		sessionLog,
		checkpointStore: store,
		turnConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 200_000,
			maxIterations: 8,
			pruneKeepLast: 1,
		},
		projectId: generateProjectId(),
		sessionId,
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	})
	return { result, store }
}

describe('checkpoint retention', () => {
	it('completes the turn when every prune throws', async () => {
		const { result, store } = await run(
			(log) => new RefusingPruneStore({ log: checkpointLogView(log) }),
		)
		expect((store as RefusingPruneStore).prunes).toBeGreaterThan(1)
		expect(result.status).toBe('completed')
		expect(result.result).toBe('done')
	})

	it('prunes through the store as the turn goes', async () => {
		const { result, store } = await run(
			(log) => new CountingPruneStore({ log: checkpointLogView(log) }),
		)
		expect(result.status).toBe('completed')
		expect((store as CountingPruneStore).pruned.length).toBeGreaterThan(0)
	})
})

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import type { CheckpointId } from '../../../types/hitl/index.js'
import type { CheckpointRunScope } from '../../../types/run/checkpoint-store.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Checkpoint retention is housekeeping, and housekeeping does not end a run.
 *
 * With retention on by default in the CLI, a prune runs after every
 * iteration's checkpoint. A prune that throws — a store that cannot delete, a
 * history it refuses to collect around — used to propagate out of the
 * iteration and fail the live run over disk it could reclaim next time.
 */

registerMock()

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

class RefusingPruneStore extends InMemoryCheckpointStore {
	prunes = 0
	async pruneCheckpoints(_scope: CheckpointRunScope, _keepLast: number): Promise<void> {
		this.prunes += 1
		throw new Error('disk says no')
	}
}

class CountingDeleteStore extends InMemoryCheckpointStore {
	deleted: CheckpointId[] = []
	override async deleteCheckpoint(scope: CheckpointRunScope, id: CheckpointId): Promise<void> {
		this.deleted.push(id)
		await super.deleteCheckpoint(scope, id)
	}
}

async function run(checkpointStore: InMemoryCheckpointStore) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-retention-'))
	dirs.push(root)
	const tools = new ToolRegistry()
	tools.register({
		name: 'probe',
		description: 'probe',
		inputSchema: z.object({ n: z.number() }),
		isReadOnly: () => true,
		execute: async ({ n }) => ({ success: true, output: `probed ${n}` }),
	})
	const turns = Array.from({ length: 4 }, (_, n) => ({
		toolCalls: [{ id: `c${n}`, name: 'probe', args: { n } }],
	}))
	return drainQuery({
		provider: new MockLLMProvider({ turns: [...turns, { text: 'done' }] }),
		tools,
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'probe four times' }],
		workingDirectory: root,
		pathBuilder: new DefaultPathBuilder(join(root, 'state')),
		checkpointStore,
		runConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 200_000,
			maxIterations: 8,
			pruneKeepLast: 1,
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	})
}

describe('checkpoint retention', () => {
	it('completes the run when every prune throws', async () => {
		const store = new RefusingPruneStore()
		const result = await run(store)
		expect(store.prunes).toBeGreaterThan(1)
		expect(result.status).toBe('completed')
		expect(result.result).toBe('done')
	})

	it('falls back to list-and-delete for a store with no pruneCheckpoints', async () => {
		const store = new CountingDeleteStore()
		const result = await run(store)
		expect(result.status).toBe('completed')
		expect(store.deleted.length).toBeGreaterThan(0)
	})
})

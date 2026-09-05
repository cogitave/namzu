import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'

import { RunPersistence } from '../../../manager/run/persistence.js'
import type { RunPersistence as RunPersistenceType } from '../../../manager/run/persistence.js'
import { CheckpointManager } from '../../../runtime/query/checkpoint.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { CheckpointId } from '../../../types/ids/index.js'
import { listDurableRuns } from '../listing.js'

/**
 * The listing behaves correctly against a store a test constructed. That is
 * not the same property as a host reaching it.
 *
 * A host does not build a `DiskCheckpointStore`; the kernel builds one for
 * it, inside `RunPersistence`, out of an `outputDir` that encodes the
 * project and session in a path and encodes the tenant nowhere at all. If
 * that construction does not hand over the attribution, the default store
 * persists every checkpoint and can enumerate none of them — the capability
 * ships, every unit test passes, and no host can use it. Reachability is its
 * own property and needs its own test.
 */

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

describe('the store a host actually gets', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-reach-'))
	})

	afterEach(async () => {
		await removeTempDirAsync(dir)
	})

	function persistence(runId: string, parentRunId?: string): RunPersistenceType {
		return new RunPersistence({
			runId,
			agentId: 'a',
			agentName: 'A',
			runConfig: {},
			providerId: 'mock',
			outputDir: dir,
			log: LOG,
			sessionId: 'f72f19ec-f321-49d6-9797-5e0607be2ca1',
			topicId: 'ad3adcfd-a2cd-47c7-80ff-d3424c05885d',
			projectId: '6a2eb356-e7e5-4f2c-9110-cbb4b66770d9',
			tenantId: '464d44b5-2bac-41e8-ab85-2cea9200a32e',
			...(parentRunId ? { parentRunId } : {}),
			// biome-ignore lint/suspicious/noExplicitAny: the config's branded id
			// types are not what this test is about; the wiring is.
		} as any)
	}

	async function park(mgr: RunPersistenceType): Promise<void> {
		const checkpoints = new CheckpointManager(mgr.getCheckpointStore(), mgr.getRunScope())
		const checkpoint = await checkpoints.create(
			{
				id: mgr.id,
				messages: [],
				currentIteration: 1,
				tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
				costInfo: { totalCost: 0 },
				getSession: () => ({ startedAt: Date.now() - 1_000 }),
				// biome-ignore lint/suspicious/noExplicitAny: the manager reads six
				// fields off the run; supplying the whole class would test nothing extra.
			} as any,
			1,
		)
		const request: HITLDecisionRequest = {
			type: 'plan_approval',
			runId: mgr.id,
			checkpointId: checkpoint.id as CheckpointId,
			// biome-ignore lint/suspicious/noExplicitAny: the plan payload is not read here.
			plan: { steps: [] } as any,
		}
		await checkpoints.park(checkpoint, request)
	}

	it('can enumerate the runs it just persisted, parent and child alike', async () => {
		const parent = persistence('c0250b29-330b-445f-b11d-2926ffd9059c')
		await parent.init()
		await park(parent)

		const child = persistence(
			'4721e070-5ba2-425a-bf5a-8cc927907e9a',
			'c0250b29-330b-445f-b11d-2926ffd9059c',
		)
		await child.init()
		await park(child)

		// Nothing was injected: this is the store the kernel builds by
		// default, asked the question a host's approval worker asks.
		const page = await listDurableRuns(parent.getCheckpointStore(), {
			tenantId: parent.tenantId,
			projectId: parent.projectId,
			sessionId: parent.sessionId,
		})

		expect(page.entries.map((e) => e.runId)).toEqual([
			'4721e070-5ba2-425a-bf5a-8cc927907e9a',
			'c0250b29-330b-445f-b11d-2926ffd9059c',
		])
		expect(page.entries.every((e) => e.park?.state === 'outstanding')).toBe(true)
		// The attribution the path does not record has to come back on the row,
		// or the row addresses nothing.
		expect(page.entries[0]?.tenantId).toBe('464d44b5-2bac-41e8-ab85-2cea9200a32e')
		expect(page.entries[0]?.parentRunId).toBe('c0250b29-330b-445f-b11d-2926ffd9059c')
	})
})

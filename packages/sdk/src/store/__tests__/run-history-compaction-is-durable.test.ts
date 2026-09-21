import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDirAsync } from '../../__fixtures__/temp-dir.js'

import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { Run } from '../../types/run/index.js'
import { durableWriteFile } from '../../utils/atomic-write.js'
import { RunDiskStore, compactRunHistory } from '../run/disk.js'
import { RUN_HISTORY_DIR } from '../run/run-history.js'

/**
 * Compaction deletes the older history generations only once everything that
 * replaces them is on stable storage.
 *
 * It used to fsync the new generation's files and nothing else: the records
 * repointed at it went through a rename with no fsync of the file or its
 * directory, and then the old generations were unlinked. A process crash
 * could not hurt that; a power loss could leave every surviving record
 * pointing at a generation it had already lost. A power loss cannot be staged
 * in a test, so this pins the order of the syncs relative to the deletions.
 */

const events: string[] = []
let oldGenerationFiles: string[] = []

vi.mock('../../utils/atomic-write.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../utils/atomic-write.js')>()
	return {
		...actual,
		syncDirectory: async (directory: string) => {
			events.push(`sync-dir ${basename(directory)}`)
			await actual.syncDirectory(directory)
		},
		durableWriteFile: async (path: string, content: string) => {
			// Every file the old reference could point at must still be there.
			const present = oldGenerationFiles.every((file) => existsSync(file))
			events.push(`durable-write ${basename(dirname(path))} old-present=${present}`)
			// The real one fsyncs the file and then its directory itself.
			await actual.durableWriteFile(path, content)
		},
	}
})

const RID = '37ddff8e-e13f-4e57-937f-d048fa323f5e' as RunId
let sequence = 0
let dir: string
let store: RunDiskStore

beforeEach(async () => {
	events.length = 0
	dir = await mkdtemp(join(tmpdir(), 'namzu-durable-compaction-'))
	store = new RunDiskStore({ baseDir: dir })
	await store.initRun(RID)
})

afterEach(async () => {
	await removeTempDirAsync(dir)
})

function checkpoint(messages: Message[]): IterationCheckpoint {
	sequence += 1
	return {
		id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}` as CheckpointId,
		runId: RID,
		iteration: sequence,
		messages,
		tokenUsage: {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 0 } as never,
		guardState: { iterationCount: 1, elapsedMs: 1 },
		createdAt: Date.now() + sequence,
	}
}

it('syncs the new generation and every rewritten record before unlinking the old one', async () => {
	let last: Message[] = []
	for (let turn = 1; turn <= 20; turn++) {
		last = [
			{ role: 'user', content: 'Keep one pinned fact current.' },
			{ role: 'system', content: `pinned ${turn} ${'x'.repeat(4_000)}` },
		]
		await store.writeCheckpoint(checkpoint(last))
	}
	await store.pruneCheckpoints(2, { minReclaimBytes: Number.MAX_SAFE_INTEGER })
	await store.writeMessages({ messages: last } as unknown as Run, 1)

	const historyDir = join(dir, RID, RUN_HISTORY_DIR)
	oldGenerationFiles = (await readdir(historyDir)).map((file) => join(historyDir, file))
	expect(oldGenerationFiles.length).toBeGreaterThan(0)
	events.length = 0

	const result = await compactRunHistory(join(dir, RID), {
		minReclaimBytes: 1,
	})
	expect(result.compacted).toBe(true)

	// The history directory is synced once the new generation is named, before
	// any record points at it; then each of the two checkpoints and the settled
	// snapshot is rewritten durably while the old generation is still present.
	expect(events).toEqual([
		`sync-dir ${RUN_HISTORY_DIR}`,
		'durable-write checkpoints old-present=true',
		'durable-write checkpoints old-present=true',
		`durable-write ${RID} old-present=true`,
	])
	// And only then were the old generation's files removed.
	expect(oldGenerationFiles.some((file) => existsSync(file))).toBe(false)
	expect((await store.listCheckpoints()).at(-1)?.messages).toEqual(last)
	expect((await store.readMessages()).kind).toBe('available')
})

it('publishes the whole body and leaves no sidecar behind', async () => {
	const target = join(dir, 'record.json')
	await durableWriteFile(target, '{"a":1}')
	await durableWriteFile(target, '{"a":2}')
	expect(await readFile(target, 'utf-8')).toBe('{"a":2}')
	expect((await readdir(dir)).filter((file) => file.endsWith('.tmp'))).toEqual([])
})

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../__fixtures__/temp-dir.js'

import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type { RunId } from '../../types/ids/index.js'
import { RunDiskStore } from '../run/disk.js'

/**
 * A checkpoint was written bare and read with a cast. Two consequences,
 * one latent and one live.
 *
 * Latent: an unstamped record is read as version 1 by definition, which is
 * correct only while version 1 is the only version there has ever been.
 * The moment a second exists, a file written by the newer build is read by
 * the older one as if it were the older shape, and the refusal that exists
 * to prevent exactly that never fires. There was no chain to hang a
 * migration on.
 *
 * Live: the read validated `id`, `iteration`, `createdAt` and `messages`
 * and skipped the budget fields — which a resume dereferences before its
 * first iteration. A run recalled at $4.80 of a $5 cap whose `costInfo`
 * came back malformed continues with `NaN`, which compares false against
 * every limit, so the guard that exists to stop it never stops it.
 */

const RID = 'run_1' as RunId

function checkpoint(overrides: Partial<IterationCheckpoint> = {}): IterationCheckpoint {
	return {
		id: 'cp_1' as CheckpointId,
		runId: RID,
		iteration: 2,
		messages: [],
		tokenUsage: {
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 4.8 } as never,
		guardState: { iterationCount: 2, elapsedMs: 1_000 },
		createdAt: Date.now(),
		...overrides,
	}
}

describe('a checkpoint on disk', () => {
	let dir: string
	let store: RunDiskStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-cpver-'))
		store = new RunDiskStore({ baseDir: dir })
		await store.initRun(RID)
	})

	afterEach(async () => {
		await removeTempDirAsync(dir)
	})

	const writeRaw = async (name: string, record: unknown) => {
		const cpDir = join(dir, RID, 'checkpoints')
		await mkdir(cpDir, { recursive: true })
		await writeFile(join(cpDir, `${name}.json`), JSON.stringify(record), 'utf-8')
	}

	it('is stamped ON DISK with the schema version it was written at', async () => {
		await store.writeCheckpoint(checkpoint())

		// Read the file, not the store: the reader re-stamps whatever it
		// parses, so asking the store back cannot tell a stamped file from
		// an unstamped one. The stamp only does its job if it is in the
		// bytes another build will read.
		const raw = JSON.parse(await readFile(join(dir, RID, 'checkpoints', 'cp_1.json'), 'utf-8')) as {
			schemaVersion?: number
		}
		expect(raw.schemaVersion).toBe(1)
	})

	it('round-trips through the stamp without losing anything', async () => {
		const original = checkpoint({ iteration: 7 })
		await store.writeCheckpoint(original)

		const read = await store.readCheckpoint(original.id)
		expect(read?.iteration).toBe(7)
		expect(read?.tokenUsage.totalTokens).toBe(150)
	})

	it('reads an unstamped record written before this existed', async () => {
		// Optional-additive is the established practice here; an older file
		// must keep working.
		const { ...bare } = checkpoint({ id: 'cp_old' as CheckpointId })
		await writeRaw('cp_old', bare)

		expect((await store.readCheckpoint('cp_old' as CheckpointId))?.iteration).toBe(2)
	})

	it('refuses a record from a future version rather than reading it partially', async () => {
		await writeRaw('cp_future', {
			...checkpoint({ id: 'cp_future' as CheckpointId }),
			schemaVersion: 99,
		})

		// Reading it with today's parser silently drops the fields this
		// build does not know about, and writing it back loses them.
		await expect(store.readCheckpoint('cp_future' as CheckpointId)).rejects.toThrow(
			/schema version 99/,
		)
	})
})

describe('budget state a resume dereferences', () => {
	let dir: string
	let store: RunDiskStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-cpbudget-'))
		store = new RunDiskStore({ baseDir: dir })
		await store.initRun(RID)
	})

	afterEach(async () => {
		await removeTempDirAsync(dir)
	})

	const writeRaw = async (name: string, record: unknown) => {
		const cpDir = join(dir, RID, 'checkpoints')
		await mkdir(cpDir, { recursive: true })
		await writeFile(join(cpDir, `${name}.json`), JSON.stringify(record), 'utf-8')
	}

	it('refuses a checkpoint with no cost information', async () => {
		const { costInfo: _dropped, ...rest } = checkpoint({ id: 'cp_nocost' as CheckpointId })
		await writeRaw('cp_nocost', rest)

		// A run that resumes with an undefined cap is worse than one that
		// refuses to resume: it looks healthy and never stops.
		await expect(store.readCheckpoint('cp_nocost' as CheckpointId)).rejects.toThrow(
			/malformed budget state/,
		)
	})

	it('refuses a NaN budget, which compares false against every limit', async () => {
		await writeRaw('cp_nan', {
			...checkpoint({ id: 'cp_nan' as CheckpointId }),
			// JSON has no NaN; this is what a serialized one becomes.
			costInfo: { totalCost: null },
		})

		await expect(store.readCheckpoint('cp_nan' as CheckpointId)).rejects.toThrow(
			/malformed budget state/,
		)
	})

	it('refuses a missing guard state', async () => {
		const { guardState: _dropped, ...rest } = checkpoint({ id: 'cp_noguard' as CheckpointId })
		await writeRaw('cp_noguard', rest)

		await expect(store.readCheckpoint('cp_noguard' as CheckpointId)).rejects.toThrow(
			/malformed budget state/,
		)
	})

	it('applies the same refusal to the listing path', async () => {
		// Two read paths disagreeing about whether damage matters is how the
		// lenient one gets trusted.
		const { costInfo: _dropped, ...rest } = checkpoint({ id: 'cp_listed' as CheckpointId })
		await writeRaw('cp_listed', rest)

		await expect(store.listCheckpoints()).rejects.toThrow(/malformed budget state/)
	})

	it('accepts a zero budget, which is a real value', async () => {
		await store.writeCheckpoint(
			checkpoint({
				id: 'cp_zero' as CheckpointId,
				tokenUsage: {
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
				costInfo: { totalCost: 0 } as never,
				guardState: { iterationCount: 0, elapsedMs: 0 },
			}),
		)

		expect(await store.readCheckpoint('cp_zero' as CheckpointId)).not.toBeNull()
	})
})

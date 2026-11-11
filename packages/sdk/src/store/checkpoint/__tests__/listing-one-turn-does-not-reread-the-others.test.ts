import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { SessionPaths } from '../../../session/paths.js'
import type { Checkpoint } from '../../../types/session/checkpoint.js'
import {
	generateCheckpointId,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../../utils/id.js'
import type { CheckpointLogView, CheckpointScope } from '../contract.js'
import { DiskSessionCheckpointStore } from '../disk.js'

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return { ...actual, readFile: vi.fn(actual.readFile) }
})

/**
 * A session keeps every turn's checkpoints in one directory, and a prune runs
 * every iteration, so listing one turn's checkpoints read and parsed every
 * document of the whole session each time. The reads are counted, not timed.
 */
const log: CheckpointLogView = {
	verifyThrough: async () => true,
	writtenDocSha256: async () => null,
	openDecisionCheckpoints: async () => [],
}

let home: string
let paths: SessionPaths
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'namzu-checkpoint-list-'))
	paths = new SessionPaths({ home, slug: '-work-project' })
})
afterEach(async () => {
	await removeTempDirAsync(home)
})

function checkpointOf(scope: CheckpointScope): Checkpoint {
	return {
		v: 1,
		kind: 'checkpoint',
		checkpointId: generateCheckpointId(),
		sessionId: scope.sessionId,
		turnId: scope.turnId,
		iteration: 1,
		throughSeq: 3,
		throughSha256: 'a'.repeat(64),
		tokenUsage: { ...EMPTY_TOKEN_USAGE },
		costInfo: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		guards: { iteration: 1, elapsedMs: 10 },
		review: { structuredAttempts: 0, answerAttempts: 0, nativeStructuredAttempts: 0 },
		turnCreatedAt: '2026-09-21T09:59:00.000Z',
		createdAt: '2026-09-21T10:00:00.000Z',
	}
}

/** A session with `earlierTurns` turns of three checkpoints each, and the current turn's. */
async function sessionWith(earlierTurns: number) {
	const store = new DiskSessionCheckpointStore({ paths, log })
	const base = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
	}
	for (let t = 0; t < earlierTurns; t++) {
		const scope = { ...base, turnId: generateTurnId() }
		for (let i = 0; i < 3; i++) await store.write(scope, checkpointOf(scope))
	}
	const current = { ...base, turnId: generateTurnId() }
	await store.write(current, checkpointOf(current))
	return { store, current }
}

describe('listing one turn’s checkpoints', () => {
	it('reads the documents of the other turns once, not on every listing', async () => {
		const reads: number[] = []
		for (const earlierTurns of [5, 20]) {
			const { store, current } = await sessionWith(earlierTurns)
			expect(await store.list(current)).toHaveLength(1) // reads everything once
			vi.mocked(readFile).mockClear()
			for (let i = 0; i < 4; i++) expect(await store.list(current)).toHaveLength(1)
			reads.push(vi.mocked(readFile).mock.calls.length)
		}
		// One document of the current turn, read on each of four listings, however many turns came before.
		expect(reads).toEqual([4, 4])
	})

	it('still reads a document that changed since it was last seen', async () => {
		const { store, current } = await sessionWith(2)
		const [mine] = await store.list(current)
		const other = { ...current, turnId: generateTurnId() }
		await store.write(other, checkpointOf(other))
		expect(await store.list(other)).toHaveLength(1)
		expect(await store.list(current)).toEqual([mine])
	})
})

import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { SessionPaths } from '../../../session/paths.js'
import type { Checkpoint } from '../../../types/session/checkpoint.js'
import { syncDirectory } from '../../../utils/atomic-write.js'
import {
	generateCheckpointId,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../../utils/id.js'
import type { CheckpointLogView, CheckpointScope } from '../contract.js'
import { DiskSessionCheckpointStore } from '../disk.js'

vi.mock('../../../utils/atomic-write.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../utils/atomic-write.js')>()
	return { ...actual, syncDirectory: vi.fn(actual.syncDirectory) }
})

const log: CheckpointLogView = {
	verifyThrough: async () => true,
	writtenDocSha256: async () => null,
	openDecisionCheckpoints: async () => [],
}

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

let home: string
let paths: SessionPaths
let scope: CheckpointScope

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'namzu-checkpoint-durability-'))
	paths = new SessionPaths({ home, slug: '-work-project' })
	scope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
	}
	vi.mocked(syncDirectory).mockClear()
})

afterEach(async () => {
	await removeTempDirAsync(home)
})

function synced(): string[] {
	return vi.mocked(syncDirectory).mock.calls.map(([directory]) => directory)
}

describe('the disk session checkpoint store on a power loss', () => {
	it('fsyncs the session directory when the write creates checkpoints/', async () => {
		const store = new DiskSessionCheckpointStore({ paths, log })
		const locator = { sessionId: scope.sessionId }
		await mkdir(paths.sessionDir(locator), { recursive: true })
		const checkpoints = paths.checkpoints(locator)

		await store.write(scope, checkpointOf(scope))
		expect(synced()).toEqual([paths.sessionDir(locator), checkpoints])

		vi.mocked(syncDirectory).mockClear()
		await store.write(scope, checkpointOf(scope))
		expect(synced()).toEqual([checkpoints])
	})

	it('fsyncs the parent of every directory the write creates', async () => {
		const store = new DiskSessionCheckpointStore({ paths, log })
		const locator = { sessionId: scope.sessionId }
		const sessionDir = paths.sessionDir(locator)
		await mkdir(dirname(sessionDir), { recursive: true })

		await store.write(scope, checkpointOf(scope))
		expect(synced()).toEqual([sessionDir, dirname(sessionDir), paths.checkpoints(locator)])
	})
})

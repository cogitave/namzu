import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { SessionPaths } from '../../../session/paths.js'
import type { CheckpointId } from '../../../types/ids/index.js'
import { type Checkpoint, CheckpointDocumentError } from '../../../types/session/checkpoint.js'
import {
	InvalidIdError,
	generateCheckpointId,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../../utils/id.js'
import {
	CheckpointIntegrityError,
	type CheckpointLogView,
	CheckpointOwnerError,
	type CheckpointScope,
	type CheckpointWriteReceipt,
	type SessionCheckpointStore,
	checkpointRecordPath,
} from '../contract.js'
import { DiskSessionCheckpointStore } from '../disk.js'
import { InMemorySessionCheckpointStore } from '../memory.js'

/**
 * A session log reduced to what a checkpoint store asks of it: the hash of
 * each record by seq, the `checkpoint_written` records, and the open
 * decisions. A test commits a write by feeding its receipt to `commit`.
 */
class FakeLog implements CheckpointLogView {
	readonly records = new Map<number, string>()
	readonly written = new Map<CheckpointId, string>()
	readonly open = new Set<CheckpointId>()
	readonly asked: CheckpointScope[] = []

	commit(receipt: CheckpointWriteReceipt): void {
		this.written.set(receipt.checkpointId, receipt.docSha256)
	}

	async verifyThrough(scope: CheckpointScope, seq: number, sha256: string): Promise<boolean> {
		this.asked.push(scope)
		return this.records.get(seq) === sha256
	}

	async writtenDocSha256(_scope: CheckpointScope, id: CheckpointId): Promise<string | null> {
		return this.written.get(id) ?? null
	}

	async openDecisionCheckpoints(): Promise<Iterable<CheckpointId>> {
		return this.open
	}
}

const THROUGH = 'a'.repeat(64)
let clock = Date.parse('2026-09-21T10:00:00.000Z')

function checkpointOf(scope: CheckpointScope, overrides: Partial<Checkpoint> = {}): Checkpoint {
	clock += 1_000
	return {
		v: 1,
		kind: 'checkpoint',
		checkpointId: generateCheckpointId(),
		sessionId: scope.sessionId,
		turnId: scope.turnId,
		iteration: 1,
		throughSeq: 3,
		throughSha256: THROUGH,
		tokenUsage: { ...EMPTY_TOKEN_USAGE },
		costInfo: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		guards: { iteration: 1, elapsedMs: 10 },
		review: { structuredAttempts: 0, answerAttempts: 0, nativeStructuredAttempts: 0 },
		turnCreatedAt: '2026-09-21T09:59:00.000Z',
		createdAt: new Date(clock).toISOString(),
		...overrides,
	}
}

function scopeOf(overrides: Partial<CheckpointScope> = {}): CheckpointScope {
	return {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
		...overrides,
	}
}

let home: string
let paths: SessionPaths
let log: FakeLog

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'namzu-session-checkpoints-'))
	paths = new SessionPaths({ home, slug: '-work-project' })
	log = new FakeLog()
	log.records.set(3, THROUGH)
})

afterEach(async () => {
	await removeTempDirAsync(home)
})

const backends: [string, () => SessionCheckpointStore][] = [
	['disk', () => new DiskSessionCheckpointStore({ paths, log })],
	['memory', () => new InMemorySessionCheckpointStore({ log })],
]

describe.each(backends)('%s session checkpoint store', (_name, make) => {
	async function written(
		store: SessionCheckpointStore,
		scope: CheckpointScope,
		overrides: Partial<Checkpoint> = {},
	): Promise<Checkpoint> {
		const checkpoint = checkpointOf(scope, overrides)
		log.commit(await store.write(scope, checkpoint))
		return checkpoint
	}

	it('returns the checkpoint_written payload and restores a committed checkpoint', async () => {
		const store = make()
		const scope = scopeOf()
		const checkpoint = checkpointOf(scope, { iteration: 4 })
		const receipt = await store.write(scope, checkpoint)
		expect(receipt).toEqual({
			checkpointId: checkpoint.checkpointId,
			iteration: 4,
			throughSeq: 3,
			throughSha256: THROUGH,
			path: `checkpoints/${checkpoint.checkpointId}.json`,
			docSha256: createHash('sha256')
				.update(`${JSON.stringify(checkpoint)}\n`)
				.digest('hex'),
		})
		expect(await store.read(scope, checkpoint.checkpointId)).toEqual(checkpoint)
		log.commit(receipt)
		expect(await store.restore(scope, checkpoint.checkpointId)).toEqual(checkpoint)
		expect(log.asked.at(-1)?.turnId).toBe(scope.turnId)
	})

	it('refuses a mismatched throughSha256 through the injected verifyThrough', async () => {
		const store = make()
		const scope = scopeOf()
		const checkpoint = await written(store, scope)
		log.records.set(3, 'b'.repeat(64))
		const refusal = store.restore(scope, checkpoint.checkpointId)
		await expect(refusal).rejects.toThrow(CheckpointIntegrityError)
		await expect(store.restore(scope, checkpoint.checkpointId)).rejects.toMatchObject({
			reason: 'through-mismatch',
			checkpointId: checkpoint.checkpointId,
		})
		log.records.delete(3)
		await expect(store.restore(scope, checkpoint.checkpointId)).rejects.toMatchObject({
			reason: 'through-mismatch',
		})
		// Reading without restoring does not consult the log.
		expect(await store.read(scope, checkpoint.checkpointId)).toEqual(checkpoint)
	})

	it('refuses a checkpoint no record commits, or whose record names other bytes', async () => {
		const store = make()
		const scope = scopeOf()
		const checkpoint = checkpointOf(scope)
		await store.write(scope, checkpoint)
		await expect(store.restore(scope, checkpoint.checkpointId)).rejects.toMatchObject({
			name: 'CheckpointIntegrityError',
			reason: 'not-recorded',
		})
		log.written.set(checkpoint.checkpointId, 'c'.repeat(64))
		await expect(store.restore(scope, checkpoint.checkpointId)).rejects.toThrow(
			/docSha256 of its checkpoint_written record/,
		)
	})

	it('answers null for a missing checkpoint and for another turn of the same session', async () => {
		const store = make()
		const scope = scopeOf()
		const other = { ...scope, turnId: generateTurnId() }
		const checkpoint = await written(store, scope)
		expect(await store.read(scope, generateCheckpointId())).toBeNull()
		expect(await store.restore(scope, generateCheckpointId())).toBeNull()
		expect(await store.read(other, checkpoint.checkpointId)).toBeNull()
		expect(await store.restore(other, checkpoint.checkpointId)).toBeNull()
		expect(await store.list(scopeOf())).toEqual([])
	})

	it("lists only the turn's checkpoints, oldest first", async () => {
		const store = make()
		const scope = scopeOf()
		const other = { ...scope, turnId: generateTurnId() }
		const second = checkpointOf(scope)
		const first = checkpointOf(scope, { createdAt: '2026-01-01T00:00:00.000Z' })
		await store.write(scope, second)
		await store.write(scope, first)
		await written(store, other)
		expect((await store.list(scope)).map((c) => c.checkpointId)).toEqual([
			first.checkpointId,
			second.checkpointId,
		])
		expect(await store.list(other)).toHaveLength(1)
	})

	it('refuses to write a document of another turn or session, or over an existing one', async () => {
		const store = make()
		const scope = scopeOf()
		await expect(
			store.write(scope, checkpointOf({ ...scope, turnId: generateTurnId() })),
		).rejects.toThrow(CheckpointOwnerError)
		await expect(
			store.write(scope, checkpointOf({ ...scope, sessionId: generateSessionId() })),
		).rejects.toThrow(CheckpointOwnerError)
		const checkpoint = await written(store, scope)
		await expect(store.write(scope, { ...checkpoint, iteration: 9 })).rejects.toThrow(
			'never replaced',
		)
		expect(await store.restore(scope, checkpoint.checkpointId)).toEqual(checkpoint)
		await expect(
			store.write(scope, { ...checkpoint, checkpointId: generateCheckpointId(), v: 2 as 1 }),
		).rejects.toThrow(CheckpointDocumentError)
	})

	it('refuses a scope with an id that is not a UUID', async () => {
		const store = make()
		const bad = scopeOf({ sessionId: '../escape' as never })
		await expect(store.list(bad)).rejects.toThrow(InvalidIdError)
		await expect(store.read(bad, generateCheckpointId())).rejects.toThrow(InvalidIdError)
		await expect(store.read(scopeOf(), 'nope' as never)).rejects.toThrow(InvalidIdError)
		await expect(
			store.write(scopeOf({ turnId: 'x' as never }), checkpointOf(scopeOf())),
		).rejects.toThrow(InvalidIdError)
	})

	it('deletes idempotently and never through another turn', async () => {
		const store = make()
		const scope = scopeOf()
		const checkpoint = await written(store, scope)
		await store.delete({ ...scope, turnId: generateTurnId() }, checkpoint.checkpointId)
		expect(await store.read(scope, checkpoint.checkpointId)).toEqual(checkpoint)
		await store.delete(scope, checkpoint.checkpointId)
		await store.delete(scope, checkpoint.checkpointId)
		expect(await store.read(scope, checkpoint.checkpointId)).toBeNull()
	})

	it('prunes the oldest down to keepLast and keeps checkpoints open decisions reference', async () => {
		const store = make()
		const scope = scopeOf()
		const other = { ...scope, turnId: generateTurnId() }
		const all: Checkpoint[] = []
		for (let i = 0; i < 5; i++) all.push(await written(store, scope, { iteration: i }))
		const untouched = await written(store, other)
		const [oldest, parked, third, fourth, newest] = all.map((c) => c.checkpointId) as [
			CheckpointId,
			CheckpointId,
			CheckpointId,
			CheckpointId,
			CheckpointId,
		]
		log.open.add(parked)
		const deleted = await store.prune(scope, 2)
		expect(deleted).toEqual([oldest, third])
		expect((await store.list(scope)).map((c) => c.checkpointId)).toEqual([parked, fourth, newest])
		expect(await store.read(other, untouched.checkpointId)).toEqual(untouched)
		expect(await store.prune(scope, 3)).toEqual([])
		log.open.clear()
		expect(await store.prune(scope, 1)).toEqual([parked, fourth])
		expect(await store.prune(scope, 1)).toEqual([])
		await expect(store.prune(scope, -1)).rejects.toThrow(RangeError)
		await expect(store.prune(scope, 1.5)).rejects.toThrow(RangeError)
	})
})

describe('the disk session checkpoint store', () => {
	it('writes <session-dir>/checkpoints/<id>.json owner-only, with no sidecar left', async () => {
		const store = new DiskSessionCheckpointStore({ paths, log })
		const scope = scopeOf()
		const checkpoint = checkpointOf(scope)
		const receipt = await store.write(scope, checkpoint)
		const path = paths.checkpointFile({ sessionId: scope.sessionId }, checkpoint.checkpointId)
		const bytes = await readFile(path)
		expect(createHash('sha256').update(bytes).digest('hex')).toBe(receipt.docSha256)
		expect(join(paths.sessionDir({ sessionId: scope.sessionId }), receipt.path)).toBe(path)
		expect(receipt.path).toBe(checkpointRecordPath(checkpoint.checkpointId))
		expect(await readdir(paths.checkpoints({ sessionId: scope.sessionId }))).toEqual([
			`${checkpoint.checkpointId}.json`,
		])
		if (process.platform !== 'win32') {
			expect((await stat(paths.checkpoints({ sessionId: scope.sessionId }))).mode & 0o777).toBe(
				0o700,
			)
			expect((await stat(path)).mode & 0o777).toBe(0o600)
		}
	})

	it("nests a child session's checkpoints under its parent's subagents directory", async () => {
		const store = new DiskSessionCheckpointStore({ paths, log })
		const parent = generateSessionId()
		const scope = scopeOf({ ancestors: [parent] })
		const checkpoint = checkpointOf(scope)
		log.commit(await store.write(scope, checkpoint))
		const locator = { sessionId: scope.sessionId, ancestors: [parent] }
		expect(paths.checkpointFile(locator, checkpoint.checkpointId)).toContain(
			join(parent, 'subagents', scope.sessionId, 'checkpoints'),
		)
		await stat(paths.checkpointFile(locator, checkpoint.checkpointId))
		expect(await store.restore(scope, checkpoint.checkpointId)).toEqual(checkpoint)
		const { ancestors: _ancestors, ...flat } = scope
		expect(await store.read(flat, checkpoint.checkpointId)).toBeNull()
	})

	it('refuses edited bytes on restore even when the edit is a valid document', async () => {
		const store = new DiskSessionCheckpointStore({ paths, log })
		const scope = scopeOf()
		const checkpoint = checkpointOf(scope)
		log.commit(await store.write(scope, checkpoint))
		const path = paths.checkpointFile({ sessionId: scope.sessionId }, checkpoint.checkpointId)
		await writeFile(path, `${JSON.stringify({ ...checkpoint, iteration: 99 })}\n`)
		expect((await store.read(scope, checkpoint.checkpointId))?.iteration).toBe(99)
		await expect(store.restore(scope, checkpoint.checkpointId)).rejects.toMatchObject({
			reason: 'document-mismatch',
		})
	})

	it('treats a document under the wrong address, a run-era document or broken JSON as damage', async () => {
		const store = new DiskSessionCheckpointStore({ paths, log })
		const scope = scopeOf()
		const locator = { sessionId: scope.sessionId }
		await mkdir(paths.checkpoints(locator), { recursive: true })

		const moved = checkpointOf({ ...scope, sessionId: generateSessionId() })
		await writeFile(paths.checkpointFile(locator, moved.checkpointId), JSON.stringify(moved))
		await expect(store.read(scope, moved.checkpointId)).rejects.toThrow(CheckpointOwnerError)
		await expect(store.list(scope)).rejects.toThrow(CheckpointOwnerError)

		const renamed = checkpointOf(scope)
		const alias = generateCheckpointId()
		await writeFile(paths.checkpointFile(locator, alias), JSON.stringify(renamed))
		await expect(store.read(scope, alias)).rejects.toThrow(CheckpointOwnerError)

		const legacy = generateCheckpointId()
		await writeFile(
			paths.checkpointFile(locator, legacy),
			JSON.stringify({ kind: 'run-checkpoint', id: legacy }),
		)
		await expect(store.read(scope, legacy)).rejects.toThrow(CheckpointDocumentError)

		const broken = generateCheckpointId()
		await writeFile(paths.checkpointFile(locator, broken), '{')
		await expect(store.read(scope, broken)).rejects.toThrow(SyntaxError)
	})

	it('ignores sidecars and strangers in the checkpoints directory', async () => {
		const store = new DiskSessionCheckpointStore({ paths, log })
		const scope = scopeOf()
		const checkpoint = checkpointOf(scope)
		await store.write(scope, checkpoint)
		const dir = paths.checkpoints({ sessionId: scope.sessionId })
		await writeFile(join(dir, `${checkpoint.checkpointId}.json.123.1.abcd.tmp`), 'partial')
		await writeFile(join(dir, 'notes.json'), '{}')
		await writeFile(join(dir, 'README'), 'hello')
		expect(await store.list(scope)).toEqual([checkpoint])
	})

	it('surfaces a filesystem error other than a missing file', async () => {
		const store = new DiskSessionCheckpointStore({ paths, log })
		const scope = scopeOf()
		const locator = { sessionId: scope.sessionId }
		// A file where the checkpoints directory should be.
		await mkdir(paths.sessionDir(locator), { recursive: true })
		await writeFile(paths.checkpoints(locator), 'not a directory')
		await expect(store.list(scope)).rejects.toMatchObject({ code: 'ENOTDIR' })
		await expect(store.read(scope, generateCheckpointId())).rejects.toMatchObject({
			code: 'ENOTDIR',
		})
		await expect(store.write(scope, checkpointOf(scope))).rejects.toMatchObject({
			code: expect.stringMatching(/EEXIST|ENOTDIR/),
		})
	})
})

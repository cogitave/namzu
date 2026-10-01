import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogBytes } from '../../store/session-log/chain.js'
import type { SessionRecordDraft } from '../../store/session-log/core.js'
import { DiskLogMedium, DiskSessionLog } from '../../store/session-log/disk.js'
import type { SessionLease } from '../../store/session-log/lease.js'
import { createAssistantMessage, createUserMessage } from '../../types/message/index.js'
import {
	generateActivityId,
	generateCheckpointId,
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../utils/id.js'
import { DiskPalStore } from '../store.js'
import {
	PalActivityAccessDeniedError,
	PalActivityIntegrityError,
	PalActivityReadLimitError,
	createPalActivitySource,
} from './source.js'
import type {
	PalActivityCursor,
	PalActivityReadOptions,
	PalActivityScope,
	PalActivitySourceOptions,
} from './types.js'

const roots: string[] = []
const releases: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const release of releases.splice(0)) await release()
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const readOptions = (options: Partial<PalActivityReadOptions> = {}): PalActivityReadOptions => ({
	signal: new AbortController().signal,
	maxRecords: 256,
	maxReadBytes: 128 * 1024,
	...options,
})
type RootDraft = Extract<SessionRecordDraft, { type: 'session_started' }>
async function fixture(
	rootPatch: Partial<RootDraft> | ((scope: PalActivityScope) => Partial<RootDraft>) = {},
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-pal-activity-')))
	roots.push(root)
	const pals = new DiskPalStore({
		root: join(root, 'registry'),
		workspaceRoot: join(root, 'workspaces'),
	})
	const pal = pals.create({ name: 'Research', purpose: 'private purpose' })
	const scope: PalActivityScope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		palId: pal.id,
		profileRevision: 1,
		sessionId: generateSessionId(),
	}
	const file = join(root, `${scope.sessionId}.jsonl`)
	const log = new DiskSessionLog({
		sessionId: scope.sessionId,
		file,
		sessionDir: join(root, scope.sessionId),
		now: () => 100,
		sync: 'all',
	})
	let lease = await log.claim({ holder: 'fixture-first', now: 100, ttlMs: 60_000 })
	if (!lease) throw new Error('Fixture writer is unavailable.')
	releases.push(async () => {
		await log.release(lease as SessionLease)
	})
	const first = await log.append(lease, {
		type: 'session_started',
		tenantId: scope.tenantId,
		projectId: scope.projectId,
		cwd: pal.workspace,
		agent: { id: pal.id, name: 'Private name' },
		origin: {
			protocol: 'desktop',
			externalSessionId: JSON.stringify(['namzu-pal', pal.id, 1, scope.sessionId]),
		},
		...(typeof rootPatch === 'function' ? rootPatch(scope) : rootPatch),
	})
	const turnId = generateTurnId()
	const started = await log.beginTurn(lease, {
		turnId,
		userMessageId: generateMessageId(),
		systemPrompt: 'private system prompt',
		config: { model: 'fixture', tokenBudget: 0, timeoutMs: 60_000 },
	})
	const bytes = new DiskLogMedium(file)
	const openJournal = vi.fn(async () => ({ log, bytes }))
	const authorize = vi.fn(async () => true)
	const options: PalActivitySourceOptions = { scope, pals, authorize, openJournal }
	const source = createPalActivitySource(options)
	async function append(draft: SessionRecordDraft) {
		return log.append(lease as SessionLease, draft)
	}
	async function takeover() {
		await log.release(lease as SessionLease)
		lease = await log.claim({ holder: 'fixture-next', now: 100, ttlMs: 60_000 })
		if (!lease) throw new Error('Fixture takeover is unavailable.')
	}
	return {
		root,
		pals,
		pal,
		scope,
		file,
		log,
		bytes,
		first,
		started,
		turnId,
		options,
		source,
		authorize,
		openJournal,
		append,
		takeover,
	}
}

describe('bounded authorized original Pal activity', () => {
	it('projects only validated metadata from original records, retaining compacted history and stable page identities', async () => {
		const f = await fixture()
		const activityId = generateActivityId()
		const checkpointId = generateCheckpointId()
		await f.append({
			type: 'activity_created',
			turnId: f.turnId,
			activityId,
			activityType: 'tool_call',
			description: 'private description',
		})
		const messageId = generateMessageId()
		await f.append({
			type: 'message',
			turnId: f.turnId,
			messageId,
			role: 'user',
			kind: 'prompt',
			content: createUserMessage('private prompt'),
		})
		await f.append({
			type: 'tool_executing',
			turnId: f.turnId,
			toolUseId: 'call_123',
			toolName: 'private tool',
			input: { secret: 'private input' },
		})
		await f.append({
			type: 'tool_completed',
			turnId: f.turnId,
			toolUseId: 'call_123',
			toolName: 'private tool',
			result: 'private result',
			isError: true,
		})
		await f.append({
			type: 'activity_updated',
			turnId: f.turnId,
			activityId,
			status: 'failed',
			output: { secret: 'private output' },
			error: 'private error',
		})
		await f.append({
			type: 'tool_review_requested',
			turnId: f.turnId,
			toolCalls: [
				{ id: 'call_123', name: 'private review', input: 'private args', isDestructive: false },
			],
			iteration: 1,
		})
		await f.append({ type: 'tool_review_completed', turnId: f.turnId, decision: 'approved' })
		await f.append({ type: 'checkpoint_created', turnId: f.turnId, checkpointId, iteration: 1 })
		await f.append({
			type: 'compaction',
			compactionId: 'fixture',
			strategy: 'fixture',
			trigger: 'manual',
			replacesSeqRange: [2, 4],
			summary: [createAssistantMessage('private summary')],
			keptMessageIds: [],
			tokensBefore: 100,
			tokensAfter: 1,
		})
		const head = vi.spyOn(f.log, 'head')
		const readAll = vi.spyOn(f.log, 'readAll')
		const fold = vi.spyOn(f.log, 'messages')
		const first = await f.source.read(readOptions({ maxRecords: 3 }))
		expect(first.scannedRecords).toBe(3)
		expect(first.complete).toBe(false)
		expect(first.facts.map((fact) => fact.type)).toEqual(['turn_started', 'activity_created'])
		expect(first.cursor.after.seq).toBe(4)
		// A new reader instance resumes from the stored cursor after process restart.
		const restarted = createPalActivitySource({
			...f.options,
			openJournal: async () => ({
				log: { sessionId: f.scope.sessionId },
				bytes: new DiskLogMedium(f.file),
			}),
		})
		const second = await restarted.read(readOptions({ cursor: first.cursor }))
		expect(second.complete).toBe(true)
		expect(second.facts.map((fact) => fact.type)).toEqual([
			'tool_executing',
			'tool_completed',
			'activity_updated',
			'tool_review_requested',
			'tool_review_completed',
			'checkpoint_created',
		])
		expect(second.facts[1]?.status).toBe('failed')
		expect(second.facts[4]?.reviewDecision).toBe('approved')
		const full = await f.source.read(readOptions())
		expect([...first.facts, ...second.facts]).toEqual(full.facts)
		expect(new Set(full.facts.map((fact) => fact.id)).size).toBe(full.facts.length)
		expect(JSON.stringify(full.facts)).not.toContain('private')
		expect(full.facts.every(Object.isFrozen)).toBe(true)
		expect(Object.isFrozen(full.cursor.after)).toBe(true)
		expect(head).not.toHaveBeenCalled()
		expect(readAll).not.toHaveBeenCalled()
		expect(fold).not.toHaveBeenCalled()
	})
	it('uses genuine original journal generation across writer takeover and later appends', async () => {
		const f = await fixture()
		const checkpointId = generateCheckpointId()
		await f.append({ type: 'turn_paused', turnId: f.turnId, checkpointId, reason: 'private pause' })
		const before = await f.source.read(readOptions())
		await f.takeover()
		await f.append({ type: 'turn_resuming', turnId: f.turnId, fromCheckpointId: checkpointId })
		const activityId = generateActivityId()
		const entry = await f.append({
			type: 'activity_created',
			turnId: f.turnId,
			activityId,
			activityType: 'shell',
			description: 'private',
		})
		expect(entry.record.gen).toBeGreaterThan(before.cursor.generation)
		const next = await f.source.read(readOptions({ cursor: before.cursor }))
		expect(next.facts.map((fact) => fact.type)).toEqual(['turn_resuming', 'activity_created'])
		expect(next.cursor.generation).toBe(entry.record.gen)
		expect(next.facts[1]).toMatchObject({
			seq: entry.record.seq,
			generation: entry.record.gen,
			activityId,
		})
		const empty = await f.source.read(readOptions({ cursor: next.cursor }))
		expect(empty.facts).toEqual([])
		expect(empty.cursor).toEqual(next.cursor)
		expect(empty.complete).toBe(true)
	})
	it('requires current observation consent before journal access and again before output', async () => {
		const f = await fixture()
		f.authorize.mockResolvedValueOnce(false)
		await expect(f.source.read(readOptions())).rejects.toBeInstanceOf(PalActivityAccessDeniedError)
		expect(f.openJournal).not.toHaveBeenCalled()
		const entered = deferred<void>()
		const continueRead = deferred<void>()
		let allowed = true
		const source = createPalActivitySource({
			...f.options,
			authorize: async () => allowed,
			openJournal: async () => ({
				log: f.log,
				bytes: {
					size: () => f.bytes.size(),
					read: async (offset, length) => {
						if (offset === f.started.pointer.offset) {
							entered.resolve()
							await continueRead.promise
						}
						return f.bytes.read(offset, length)
					},
				},
			}),
		})
		const reading = source.read(readOptions())
		await entered.promise
		allowed = false
		continueRead.resolve()
		await expect(reading).rejects.toBeInstanceOf(PalActivityAccessDeniedError)
		// A paused Pal may still be observed when the operator explicitly permits it.
		f.pals.update(f.pal.id, 1, { paused: true })
		expect((await f.source.read(readOptions())).facts).toHaveLength(1)
	})
	it.each(['openJournal', 'size'] as const)(
		'checks revocation after pending %s before reading any original bytes',
		async (port) => {
			const f = await fixture()
			const entered = deferred<void>()
			const proceed = deferred<void>()
			let allowed = true
			const read = vi.spyOn(f.bytes, 'read')
			const source = createPalActivitySource({
				...f.options,
				authorize: async () => allowed,
				openJournal: async () => {
					if (port === 'openJournal') {
						entered.resolve()
						await proceed.promise
					}
					return {
						log: f.log,
						bytes: {
							read: (offset, length) => f.bytes.read(offset, length),
							size: async () => {
								if (port === 'size') {
									entered.resolve()
									await proceed.promise
								}
								return f.bytes.size()
							},
						},
					}
				},
			})
			const reading = source.read(readOptions())
			await entered.promise
			allowed = false
			proceed.resolve()
			await expect(reading).rejects.toBeInstanceOf(PalActivityAccessDeniedError)
			expect(read).not.toHaveBeenCalled()
		},
	)
	it.each(['tenant', 'project', 'cwd', 'origin', 'profile', 'parent', 'fork'] as const)(
		'rejects a %s root before projection',
		async (wrong) => {
			const changes = (scope: PalActivityScope): Partial<RootDraft> =>
				wrong === 'tenant'
					? { tenantId: generateTenantId() }
					: wrong === 'project'
						? { projectId: generateProjectId() }
						: wrong === 'cwd'
							? { cwd: '/foreign/private/workspace' }
							: wrong === 'origin'
								? { origin: { protocol: 'acp', externalSessionId: 'foreign' } }
								: wrong === 'profile'
									? {
											origin: {
												protocol: 'desktop',
												externalSessionId: JSON.stringify([
													'namzu-pal',
													scope.palId,
													2,
													scope.sessionId,
												]),
											},
										}
									: wrong === 'parent'
										? {
												parent: {
													sessionId: generateSessionId(),
													turnId: generateTurnId(),
													toolCallId: 'private',
													rootSessionId: generateSessionId(),
													depth: 1,
													kind: 'agent_spawn',
												},
											}
										: {
												forkedFrom: {
													sessionId: generateSessionId(),
													turnId: generateTurnId(),
													checkpointId: generateCheckpointId(),
												},
											}
			const f = await fixture(changes)
			await expect(f.source.read(readOptions())).rejects.toBeInstanceOf(PalActivityIntegrityError)
		},
	)
	it('rejects a foreign cursor before opening its journal and a foreign log port before reading bytes', async () => {
		const one = await fixture()
		const page = await one.source.read(readOptions())
		const two = await fixture()
		await expect(two.source.read(readOptions({ cursor: page.cursor }))).rejects.toBeInstanceOf(
			PalActivityIntegrityError,
		)
		expect(two.openJournal).not.toHaveBeenCalled()
		const read = vi.spyOn(one.bytes, 'read')
		const foreign = createPalActivitySource({
			...one.options,
			openJournal: async () => ({ log: { sessionId: two.scope.sessionId }, bytes: one.bytes }),
		})
		await expect(foreign.read(readOptions())).rejects.toBeInstanceOf(PalActivityIntegrityError)
		expect(read).not.toHaveBeenCalled()
	})
	it('rejects changed cursor generation, digest and rewritten journal anchors', async () => {
		const f = await fixture()
		const page = await f.source.read(readOptions())
		await expect(
			f.source.read(readOptions({ cursor: { ...page.cursor, scopeHash: '0'.repeat(64) } })),
		).rejects.toBeInstanceOf(PalActivityIntegrityError)
		await expect(
			f.source.read(
				readOptions({
					cursor: { ...page.cursor, root: { ...page.cursor.root, sha256: '0'.repeat(64) } },
				}),
			),
		).rejects.toBeInstanceOf(PalActivityIntegrityError)
		await expect(
			f.source.read(
				readOptions({ cursor: { ...page.cursor, generation: page.cursor.generation + 1 } }),
			),
		).rejects.toBeInstanceOf(PalActivityIntegrityError)
		await expect(
			f.source.read(
				readOptions({
					cursor: { ...page.cursor, after: { ...page.cursor.after, sha256: '0'.repeat(64) } },
				}),
			),
		).rejects.toBeInstanceOf(PalActivityIntegrityError)
		const original = await readFile(f.file, 'utf8')
		await writeFile(f.file, original.replace('private system prompt', 'changed system prompt'))
		await expect(f.source.read(readOptions({ cursor: page.cursor }))).rejects.toBeInstanceOf(
			PalActivityIntegrityError,
		)
	})
	it('rejects a broken successor and torn trailing bytes without issuing a new cursor', async () => {
		const f = await fixture()
		await f.append({
			type: 'activity_created',
			turnId: f.turnId,
			activityId: generateActivityId(),
			activityType: 'shell',
			description: 'private',
		})
		const original = await readFile(f.file, 'utf8')
		await writeFile(f.file, original.replace('private system prompt', 'changed system prompt'))
		await expect(f.source.read(readOptions())).rejects.toBeInstanceOf(PalActivityIntegrityError)
		await writeFile(f.file, original)
		await appendFile(f.file, '{"private":')
		await expect(f.source.read(readOptions({ maxRecords: 1 }))).rejects.toBeInstanceOf(
			PalActivityIntegrityError,
		)
	})
	it('validates selected metadata independently of loose event-payload record schemas', async () => {
		const f = await fixture()
		// The existing journal schema validates this event envelope, but not its status payload.
		await f.append({
			type: 'activity_updated',
			turnId: f.turnId,
			activityId: generateActivityId(),
			status: { body: 'private malformed payload' },
		} as unknown as SessionRecordDraft)
		await expect(f.source.read(readOptions())).rejects.toBeInstanceOf(PalActivityIntegrityError)
	})
	it.each(['completed', 'cancelled', 'failed'] as const)(
		'retains the genuine %s terminal status without private settlement text',
		async (status) => {
			const f = await fixture()
			const settlement = {
				status,
				iterations: 1,
				usage: {
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
				cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
				durationMs: 0,
				resultSource: 'model' as const,
				abandonedTaskIds: [],
				abandonedJobIds: [],
			}
			await f.append(
				status === 'failed'
					? { type: 'turn_failed', turnId: f.turnId, error: 'private terminal error', settlement }
					: {
							type: 'turn_completed',
							turnId: f.turnId,
							result: 'private terminal result',
							stopReason: status === 'cancelled' ? 'cancelled' : 'end_turn',
							settlement,
						},
			)
			const page = await f.source.read(readOptions())
			expect(page.facts[1]?.status).toBe(status)
			expect(JSON.stringify(page.facts)).not.toContain('private')
		},
	)
	it('enforces total requested I/O, including anchors, rather than materializing history', async () => {
		const f = await fixture()
		await f.append({
			type: 'message',
			turnId: f.turnId,
			messageId: generateMessageId(),
			role: 'user',
			content: createUserMessage('x'.repeat(8000)),
		})
		const read = vi.spyOn(f.bytes, 'read')
		const first = await f.source.read(readOptions({ maxRecords: 1, maxReadBytes: 4096 }))
		expect(first.scannedRecords).toBe(1)
		expect(first.complete).toBe(false)
		expect(first.readBytes).toBe(read.mock.calls.reduce((sum, [, length]) => sum + length, 0))
		expect(first.readBytes).toBeLessThanOrEqual(4096)
		read.mockClear()
		await expect(
			f.source.read(readOptions({ cursor: first.cursor, maxReadBytes: 4096 })),
		).rejects.toBeInstanceOf(PalActivityReadLimitError)
		expect(read.mock.calls.reduce((sum, [, length]) => sum + length, 0)).toBeLessThanOrEqual(4096)
	})
	it('captures input scope and cursor before awaited authorization and preserves abort causes', async () => {
		const f = await fixture()
		const page = await f.source.read(readOptions())
		const entered = deferred<void>()
		const proceed = deferred<void>()
		const scope = { ...f.scope }
		const source = createPalActivitySource({
			...f.options,
			scope,
			authorize: async () => {
				entered.resolve()
				await proceed.promise
				return true
			},
		})
		const cursor = structuredClone(page.cursor) as {
			-readonly [Key in keyof PalActivityCursor]: PalActivityCursor[Key]
		}
		const reading = source.read(readOptions({ cursor }))
		await entered.promise
		scope.palId = f.pals.create({ name: 'Other' }).id
		cursor.generation++
		proceed.resolve()
		expect((await reading).cursor).toEqual(page.cursor)
		const controller = new AbortController()
		const stopped = new Error('operator cancelled activity read')
		controller.abort(stopped)
		await expect(f.source.read(readOptions({ signal: controller.signal }))).rejects.toBe(stopped)
	})
	it('rejects a journal truncated during reading and stops I/O when aborted at an anchor', async () => {
		const f = await fixture()
		const page = await f.source.read(readOptions())
		const sizes = vi.spyOn(f.bytes, 'size')
		sizes.mockResolvedValueOnce(await f.bytes.size()).mockResolvedValueOnce(0)
		await expect(f.source.read(readOptions())).rejects.toBeInstanceOf(PalActivityIntegrityError)
		sizes.mockRestore()
		const controller = new AbortController()
		const reason = new Error('cancelled during anchor')
		let reads = 0
		const bytes: LogBytes = {
			size: () => f.bytes.size(),
			read: async (offset, length) => {
				reads++
				if (offset === page.cursor.after.offset) controller.abort(reason)
				return f.bytes.read(offset, length)
			},
		}
		const source = createPalActivitySource({
			...f.options,
			openJournal: async () => ({ log: f.log, bytes }),
		})
		await expect(
			source.read(readOptions({ cursor: page.cursor, signal: controller.signal })),
		).rejects.toBe(reason)
		expect(reads).toBe(3)
	})
})

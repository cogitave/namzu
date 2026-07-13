// ses_017 fix-batch — L3 and L8. The two places where the lease's guarantees were words
// rather than code.
//
// L3 — THE LEASE FILE WAS THE ONE NON-ATOMIC WRITE IN THE STORE. Every other durable write
// goes through write-temp-then-rename precisely so a reader never sees a partial file. The
// lease was created with `writeFile(..., { flag: 'wx' })`, which is an exclusive CREATE and
// then, in a SECOND syscall, a write — so between the two the file exists and is EMPTY. A
// reader landing there does `JSON.parse('')` and gets an untyped `SyntaxError` thrown out of
// every lease entry point: another `acquireLease` (so `query()` dies with a parse error
// instead of `RunLeaseHeldError`), `resumeDecision`'s lease check (so a human's approval is
// rejected with an opaque 500 the caller cannot tell from a server fault), an operator's
// `readRunLease`, the incumbent's own fence. And the window is EXACTLY the takeover, which
// is when concurrent readers are most likely.
//
// L8 — THE FENCE WAS CHECK-THEN-ACT. `assertFence` read the current token in one `await` and
// the write committed in a later one. A takeover landing in that gap made the check a lie:
// the superseded segment passed it, was descheduled, and landed its write on the run
// somebody else now owned — the exact clobber the fence exists to refuse. The docs stated
// the guarantee absolutely ("a writer whose token is not the current one is not permitted to
// write at all"); the implementation only narrowed the window.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunId } from '../../../types/ids/index.js'
import type { Run } from '../../../types/run/index.js'
import { RunLeaseLostError, RunLeaseUnreadableError } from '../../../types/run/lease.js'

/**
 * Hooks into the filesystem, so a test can stand exactly where a concurrent process would.
 *
 * `renameGate` parks the FIRST `rename()` onto `run.json` — which is the instant a fenced
 * write commits, and therefore the instant the L8 race is decided. `writes` records every
 * `writeFile` so the L3 test can assert what the lease's create actually did.
 */
const fsHooks = {
	renameGate: null as null | { reached: () => void; release: Promise<void> },
	renameGateArmed: false,
	writes: [] as Array<{ path: string; flag?: string }>,
	links: [] as string[],
}

vi.mock('node:fs/promises', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...real,
		writeFile: async (path: unknown, data: unknown, options?: unknown) => {
			fsHooks.writes.push({
				path: String(path),
				flag: (options as { flag?: string } | undefined)?.flag,
			})
			return real.writeFile(path as string, data as string, options as never)
		},
		link: async (from: unknown, to: unknown) => {
			fsHooks.links.push(String(to))
			return real.link(from as string, to as string)
		},
		rename: async (from: unknown, to: unknown) => {
			if (fsHooks.renameGateArmed && String(to).endsWith('run.json') && fsHooks.renameGate) {
				const gate = fsHooks.renameGate
				fsHooks.renameGateArmed = false
				gate.reached()
				await gate.release
			}
			return real.rename(from as string, to as string)
		},
	}
})

const { RunDiskStore } = await import('../disk.js')

const RUN_ID = 'run_atomic' as RunId

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-ses017-atomic-'))
}

async function storeFor(baseDir: string) {
	const store = new RunDiskStore({ baseDir })
	await store.initRun(RUN_ID)
	return store
}

function runRecord(status: Run['status'], marker: string): Run {
	return {
		id: RUN_ID,
		status,
		metadata: { agentId: 'a', agentName: marker, config: { model: 'm' }, provider: 'fake' },
		messages: [{ role: 'assistant', content: marker }],
		tokenUsage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: 0, cacheDiscount: 0 },
		currentIteration: 1,
		startedAt: Date.now(),
	} as Run
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
	fsHooks.renameGate = null
	fsHooks.renameGateArmed = false
	fsHooks.writes = []
	fsHooks.links = []
})

describe('L3 — a lease file never exists without its content', () => {
	it('the lease is PUBLISHED atomically: its path is never the target of a create-then-write', async () => {
		const baseDir = tmp()
		const store = await storeFor(baseDir)
		await store.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'segment-A' })

		const leasePath = join(baseDir, RUN_ID, 'leases', '000001.json')

		// THE DEFECT, stated as the assertion that catches it: `writeFile(leasePath, json,
		// { flag: 'wx' })` creates the file and *then* fills it, so for the duration of one
		// syscall the lease exists and is empty. Nothing may write to the lease's own path —
		// the content goes to a private temp name, and `link()` is what publishes it. A link
		// either exists with the whole record behind it or does not exist at all; there is no
		// third state, which is the entire property the lease's readers depend on.
		expect(fsHooks.writes.map((w) => w.path)).not.toContain(leasePath)
		expect(fsHooks.writes.some((w) => w.flag === 'wx' && w.path.endsWith('000001.json'))).toBe(
			false,
		)
		expect(fsHooks.links).toContain(leasePath)

		// And the arbitration the takeover depends on is unchanged: an exclusive create that
		// exactly one racer can win.
		expect(JSON.parse(readFileSync(leasePath, 'utf-8')).holderId).toBe('segment-A')
	})

	it.each([
		['empty (the exact torn state a reader used to land on)', ''],
		['truncated mid-write', '{"runId":"run_atomic","tok'],
	])('a lease that cannot be read fails CLOSED, not with a SyntaxError — %s', async (_, bytes) => {
		const baseDir = tmp()
		const store = await storeFor(baseDir)
		await store.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'segment-A' })
		await store.releaseLease()

		// A second segment is taking the run over, and a reader lands mid-create.
		writeFileSync(join(baseDir, RUN_ID, 'leases', '000002.json'), bytes)

		const reader = await storeFor(baseDir)

		// Every one of these used to be a raw `SyntaxError: Unexpected end of JSON input`, and
		// each of them reached a caller that had no way to tell it from a server fault.
		await expect(reader.readLease()).rejects.toThrow(RunLeaseUnreadableError)
		await expect(
			reader.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'segment-B' }),
		).rejects.toThrow(RunLeaseUnreadableError)

		// The one thing it must NEVER do: read an unreadable lease as `free` and hand the run
		// to a second driver on the strength of a file it failed to parse.
		await expect(reader.readLease()).rejects.not.toThrow(SyntaxError)
	})

	it('the incumbent’s own fence fails closed on an unreadable lease — it does not write', async () => {
		const baseDir = tmp()
		const store = await storeFor(baseDir)
		await store.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'segment-A' })
		await store.writeRunMeta(runRecord('running', 'segment-A'))

		// Somebody is taking the run over, and their lease file is momentarily unreadable.
		writeFileSync(join(baseDir, RUN_ID, 'leases', '000002.json'), '')

		await expect(store.writeRunMeta(runRecord('completed', 'segment-A'))).rejects.toThrow(
			RunLeaseUnreadableError,
		)

		// The refusal wrote nothing. A fence that cannot establish it still holds the run must
		// not fall through to writing.
		const meta = JSON.parse(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8'))
		expect(meta.status).toBe('running')
	})
})

describe('L8 — a takeover cannot land between a fenced write’s check and its commit', () => {
	it('a stalled segment whose write is in flight when the takeover lands does NOT get the last word', async () => {
		const baseDir = tmp()

		// A takes the run and stalls. Its lease goes stale — but stale is not fenced: nobody
		// has taken the run yet, so A's token is still the current one and its fence passes.
		const stalled = await storeFor(baseDir)
		await stalled.acquireLease(RUN_ID, { ttlMs: 40, holderId: 'stalled' })
		await sleep(60)

		// A wakes up and finishes what it was doing. Park it at the exact instant its write
		// commits — after its fence check, before its rename. This is the window.
		let reached!: () => void
		let release!: () => void
		fsHooks.renameGate = {
			reached: () => reached(),
			release: new Promise<void>((r) => {
				release = r
			}),
		}
		const atTheGate = new Promise<void>((r) => {
			reached = r
		})
		fsHooks.renameGateArmed = true

		const stalledWrite = stalled.writeRunMeta(runRecord('failed', 'stalled')).catch((e) => e)
		await atTheGate

		// …and while it sits there, the run is taken over and driven to completion by somebody
		// else. THIS is what the old fence permitted: B's takeover lands in A's gap, B writes,
		// and then A's rename — checked an eternity ago, against a token that is no longer the
		// run's — commits last and clobbers it.
		const taker = await storeFor(baseDir)
		const takeover = (async () => {
			await taker.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'taker' })
			await taker.writeRunMeta(runRecord('completed', 'taker'))
		})()

		// Every chance to land: if the takeover CAN interleave, it has 60ms of an idle event
		// loop in which to do it.
		await sleep(60)
		release()
		await stalledWrite
		await takeover

		// The run's record is the TAKER's. Not a merge, not the stalled segment's.
		const meta = JSON.parse(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8'))
		expect(meta.status).toBe('completed')
		expect(meta.metadata.agentName).toBe('taker')

		// And from here the stalled segment is refused outright — it has been superseded, and
		// it now finds out the moment it tries anything.
		await expect(stalled.writeRunMeta(runRecord('failed', 'stalled'))).rejects.toThrow(
			RunLeaseLostError,
		)
	})

	it('a takeover cannot split a run’s record between two segments — persist() is ONE commit', async () => {
		const baseDir = tmp()
		const stalled = await storeFor(baseDir)
		await stalled.acquireLease(RUN_ID, { ttlMs: 40, holderId: 'stalled' })
		await sleep(60)

		let reached!: () => void
		let release!: () => void
		fsHooks.renameGate = {
			reached: () => reached(),
			release: new Promise<void>((r) => {
				release = r
			}),
		}
		const atTheGate = new Promise<void>((r) => {
			reached = r
		})
		fsHooks.renameGateArmed = true

		// The half-fenced variant, which is worse than the clobber: `persist()` chains
		// run.json → messages.json → index.json, each re-checking the fence independently. A
		// takeover mid-chain let the first write through and refused the second, leaving
		// `run.json` written by one segment and `messages.json` by another — a record whose
		// persisted `messageCount` and status do not describe its own history, which is
		// exactly what the next resume reads back.
		const record = runRecord('completed', 'stalled')
		const stalledPersist = (async () => {
			await stalled.writeRunMeta(record)
			await stalled.writeMessages(record)
		})()
		// The commit group holds the lock across both writes, so the gate parks the whole
		// group, not just its first member.
		const raced = await Promise.race([
			atTheGate.then(() => 'gate' as const),
			stalledPersist.then(() => 'done' as const).catch(() => 'refused' as const),
		])
		expect(raced).toBe('gate')

		const taker = await storeFor(baseDir)
		const takeover = (async () => {
			await taker.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'taker' })
			await taker.writeRunMeta(runRecord('running', 'taker'))
			await taker.writeMessages(runRecord('running', 'taker'))
		})()

		await sleep(60)
		release()
		await stalledPersist.catch(() => undefined)
		await takeover

		// Both halves of the record describe the SAME segment. Never one each.
		const meta = JSON.parse(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8'))
		const messages = JSON.parse(readFileSync(join(baseDir, RUN_ID, 'messages.json'), 'utf-8'))
		expect(meta.metadata.agentName).toBe('taker')
		expect(messages[0].content).toBe('taker')
	})
})

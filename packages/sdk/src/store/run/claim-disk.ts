/**
 * A run claim on a filesystem, correct across PROCESSES.
 *
 * The in-memory store arbitrates with a `Map`, which is exactly as much
 * arbitration as one process needs and none at all for the deployment this
 * exists for. Two workers draining a queue are two processes, often two
 * machines, and the only thing they share is the directory.
 *
 * ## The primitive
 *
 * `O_CREAT | O_EXCL` — node's `wx` flag. Exactly one concurrent creator of a
 * given path succeeds and every other gets `EEXIST`, decided by the kernel
 * rather than by a read-then-write this code could lose a race inside. The
 * repository already owns one genuine cross-process mutex built on it, for
 * the boot filesystem migration. This generalizes the IDEA and deliberately
 * does not reuse that file: a lock whose meaning depends on which caller took
 * it is a lock with two meanings.
 *
 * ## Why `wx` alone is not enough
 *
 * `wx` gives mutual exclusion and no expiry, so a holder that dies wedges the
 * run forever — which is the failure a lease exists to prevent, not a smaller
 * version of it. So the claim itself is an ordinary file holding
 * `{holder, fence, expiresAt}`, and `wx` guards only the RECLAIM: the window
 * in which an expired claim is read, judged and replaced.
 *
 * Uncontended take of a free run is a single `wx` create of the claim file —
 * one syscall, no lock, no window. Reclaiming an expired one serializes on a
 * short-lived guard file and re-reads the claim INSIDE it, so two workers
 * reclaiming the same dead holding produce one winner and one `null` rather
 * than two claims at the same fence.
 *
 * ## What it does not do
 *
 * It does not detect liveness. Nothing can, from here — a stalled holder, a
 * suspended container and a partitioned network are indistinguishable, and
 * they are indistinguishable from the holder's own side too, which is why it
 * keeps writing. The fence is the answer: the write is checked, not the
 * writer.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClaimFence, ClaimRunOptions, RunClaim } from '../../types/run/checkpoint-store.js'

/** File holding the run's current claim, inside the run's directory. */
const CLAIM_FILE = 'claim.json'
/** Short-lived `wx` guard serializing reclaim of an expired claim. */
const RECLAIM_GUARD = 'claim.reclaiming'

/**
 * How long a reclaim guard is honoured before it is itself treated as
 * abandoned.
 *
 * A worker killed between taking the guard and replacing the claim would
 * otherwise wedge the run permanently — the guard would be the thing that
 * needs a lease. It is held for two file operations, so anything approaching
 * a second is a crash rather than slowness.
 */
const RECLAIM_GUARD_TTL_MS = 5_000

function isErrno(err: unknown, code: string): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

function isRunClaim(value: unknown): value is RunClaim {
	if (typeof value !== 'object' || value === null) return false
	const c = value as Partial<RunClaim>
	return (
		typeof c.holder === 'string' &&
		typeof c.fence === 'number' &&
		Number.isFinite(c.fence) &&
		typeof c.expiresAt === 'number' &&
		Number.isFinite(c.expiresAt)
	)
}

/**
 * Read the run's current claim, or `null` when there is none.
 *
 * Three outcomes, not two, and the third is the one CI caught.
 *
 * A claim that cannot be parsed returns `'unreadable'`, NOT `null`. The first
 * version collapsed them and three workers claimed one run on a loaded CI
 * box: a reader can observe the claim file mid-replacement and get an empty
 * or partial string, `JSON.parse` throws, "damaged" became "no claim", and
 * every worker that saw it took the run. The window is invisible on an idle
 * laptop and wide open under real contention.
 *
 * `ENOENT` is the only absence that means free. Everything else means "there
 * is something here I could not read", and a lease must treat that as held —
 * refuse rather than degrade, because degrading here hands one run to every
 * worker at once, which is the exact condition this file exists to prevent.
 *
 * A permanently corrupt claim therefore blocks the run until its lease would
 * have expired, and no longer: the expiry is judged from a claim that parses,
 * so an unparseable one is simply retried by the next caller. That is the
 * right cost — a run briefly unclaimable beats a run claimed twice.
 */
export async function readClaim(runDir: string): Promise<RunClaim | null | 'unreadable'> {
	let raw: string
	try {
		raw = await readFile(join(runDir, CLAIM_FILE), 'utf-8')
	} catch (err) {
		// The ONLY absence that means "free". Nothing else may.
		if (isErrno(err, 'ENOENT')) return null
		throw err
	}

	try {
		const parsed: unknown = JSON.parse(raw)
		return isRunClaim(parsed) ? parsed : 'unreadable'
	} catch {
		return 'unreadable'
	}
}

/** Take or extend the run's claim. `null` when somebody else holds it. */
export async function acquireClaim(
	runDir: string,
	options: ClaimRunOptions,
): Promise<RunClaim | null> {
	const now = options.now ?? Date.now()
	await mkdir(runDir, { recursive: true })

	const claimPath = join(runDir, CLAIM_FILE)
	const fresh = (previousFence: number): RunClaim => ({
		holder: options.holder,
		fence: previousFence + 1,
		expiresAt: now + options.ttlMs,
	})

	// Fast path: the run has never been claimed. `wx` makes exactly one of
	// any number of simultaneous callers the creator, so this needs no guard
	// and no read — the losers fall through and read what the winner wrote.
	try {
		const claim = fresh(0)
		await writeFile(claimPath, JSON.stringify(claim), { flag: 'wx' })
		return claim
	} catch (err) {
		if (!isErrno(err, 'EEXIST')) throw err
	}

	const held = await readClaim(runDir)
	// Unreadable means somebody is mid-replacement, or the file is damaged.
	// Either way there IS a claim here and this caller is not it.
	if (held === 'unreadable') return null
	if (held && now < held.expiresAt && held.holder !== options.holder) return null

	// Reclaim or renew. Both replace the file and both must be serialized:
	// two workers that read the same expired claim would otherwise write two
	// claims carrying the SAME fence, and a fence that two holders share
	// fences neither of them out.
	const guardPath = join(runDir, RECLAIM_GUARD)
	if (!(await takeGuard(guardPath, now))) return null

	try {
		// Re-read INSIDE the guard. The claim may have been reclaimed between
		// the read above and the guard being taken, and that read is the only
		// thing standing between two workers and one fence.
		const current = await readClaim(runDir)
		if (current === 'unreadable') return null
		if (current && now < current.expiresAt && current.holder !== options.holder) return null

		const claim = fresh(current?.fence ?? held?.fence ?? 0)
		// Written to a temp path and renamed, so a reader never observes a
		// half-written claim — `rename` over an existing path is atomic on
		// every filesystem this runs on.
		const tmp = `${claimPath}.${process.pid}.${claim.fence}`
		await writeFile(tmp, JSON.stringify(claim), 'utf-8')
		await rename(tmp, claimPath)
		return claim
	} finally {
		await unlink(guardPath).catch(() => undefined)
	}
}

/**
 * Take the reclaim guard, breaking one that is older than its own TTL.
 *
 * The break is itself racy in principle — two workers could both decide a
 * stale guard is breakable — and it does not matter, because the claim is
 * re-read under the guard and the loser of that read returns `null`. The
 * guard narrows the window; the re-read is what closes it.
 */
async function takeGuard(guardPath: string, now: number): Promise<boolean> {
	try {
		await writeFile(guardPath, JSON.stringify({ at: now, pid: process.pid }), { flag: 'wx' })
		return true
	} catch (err) {
		if (!isErrno(err, 'EEXIST')) throw err
	}

	// An unreadable guard is a guard being written RIGHT NOW, not an ancient
	// one. This is the same mistake as the claim reader made, one function
	// over, and it produced the same symptom: reading the file mid-write threw,
	// the catch left `takenAt` at 0, `now - 0` cleared any TTL, and the guard
	// was broken the instant it was taken. Two workers then ran the reclaim
	// concurrently and both wrote — which is precisely what the guard exists to
	// stop.
	//
	// So a guard is breakable only when its timestamp PARSES and is genuinely
	// old. Anything else means somebody holds it.
	let takenAt: number | undefined
	try {
		const parsed: unknown = JSON.parse(await readFile(guardPath, 'utf-8'))
		if (typeof parsed === 'object' && parsed !== null) {
			const at = (parsed as { at?: unknown }).at
			if (typeof at === 'number' && Number.isFinite(at)) takenAt = at
		}
	} catch (err) {
		// Gone between the failed create and this read: the holder finished
		// and released. Retry from the top rather than assuming anything.
		if (isErrno(err, 'ENOENT')) return false
	}

	if (takenAt === undefined || now - takenAt < RECLAIM_GUARD_TTL_MS) return false

	await unlink(guardPath).catch(() => undefined)
	try {
		await writeFile(guardPath, JSON.stringify({ at: now, pid: process.pid }), { flag: 'wx' })
		return true
	} catch (err) {
		if (isErrno(err, 'EEXIST')) return false
		throw err
	}
}

/** Drop the claim if `fence` is the one currently recorded. */
export async function releaseClaim(runDir: string, fence: ClaimFence): Promise<void> {
	const held = await readClaim(runDir)
	if (!held || held === 'unreadable' || held.fence !== fence) return
	await unlink(join(runDir, CLAIM_FILE)).catch(() => undefined)
}

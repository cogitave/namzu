/**
 * A run claim on a filesystem, correct across PROCESSES.
 *
 * ## The fence is the filename
 *
 * A run's claims live at `{runDir}/claims/{fence}.json`. Taking the run means
 * exclusively creating the next number; the kernel makes exactly one of any
 * number of simultaneous callers the creator, and every other gets `EEXIST`.
 * The current holding is the highest-numbered file.
 *
 * That single decision is the whole mechanism, and it is what the first
 * version of this file got wrong. That version kept ONE mutable `claim.json`
 * and protected it with a lock, which needed a stale-lock breaker, which was
 * `unlink` followed by an exclusive create — two operations. An adversarial
 * pass reproduced the consequence from separate processes: two workers both
 * judge a stale guard breakable, the second unlinks the FIRST one's fresh
 * guard, both end up inside the section believing they hold it, neither has
 * written yet so neither can be the loser of a re-read, and both write the
 * same fence. Twenty-six of three hundred runs went to two workers at an
 * identical fence — and an identical fence fences nobody out, because the
 * comparison is `<`.
 *
 * Numbering the files instead removes every one of those steps. There is no
 * lock to go stale, so no breaker, so no window. Concurrency is decided by
 * one `O_CREAT | O_EXCL`.
 *
 * ## Four properties this layout gives for free
 *
 * **Monotonic across release and deletion.** Fences are file names that stay,
 * so releasing cannot rewind the counter. Deleting `claim.json` used to send
 * the next caller down a fresh-claim path that minted fence 1 again — so a
 * worker stalled at fence 1 could write alongside the new holder, and the
 * documented `finally { releaseRun() }` did it on every pass. Releasing here
 * appends a tombstone rather than removing anything.
 *
 * **Unreadable content cannot wedge the run.** The fence is in the name, so a
 * damaged or half-written body never hides the ordering. A caller reads the
 * highest number and takes the next one; the previous holder, alive or not,
 * is fenced out by arithmetic. Refusing to take an unparseable claim was safe
 * against double-writing and left the run permanently unclaimable, which is
 * the failure a lease exists to prevent.
 *
 * **The write-time fence check needs no parsing at all.** It compares a
 * number against a directory listing, so a corrupt body cannot make the check
 * skip itself.
 *
 * **No `rename` and no `unlink` on the contended path.** Renaming over a path
 * another process merely holds open for reading fails on non-POSIX
 * filesystems — measured at 84% under two concurrent readers — and a listing
 * sweep reads exactly these files. Creating a new name never collides with a
 * reader.
 *
 * ## What it still does not do
 *
 * It does not detect liveness. Nothing can from here: a stalled holder, a
 * suspended container and a partitioned network are indistinguishable, and
 * they are indistinguishable from the holder's own side too, which is why it
 * keeps writing. The fence is the answer — the write is checked, not the
 * writer.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClaimFence, ClaimRunOptions, RunClaim } from '../../types/run/checkpoint-store.js'

/** Directory holding one file per holding, named for its fence. */
const CLAIMS_DIR = 'claims'

/**
 * How many times a caller re-reads and retries after losing the create race.
 *
 * Losing means somebody else took the number, and the next read sees their
 * live claim and returns `null` — so this is bounded by genuine contention
 * rather than by chance. A handful is generous; the loop exists so a burst of
 * simultaneous takers does not report "held" to a caller that never actually
 * raced the eventual holder.
 */
const MAX_ATTEMPTS = 8

function isErrno(err: unknown, code: string): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

/** The stored body. The fence is the file name, not this. */
interface ClaimBody {
	readonly holder: string
	readonly expiresAt: number
}

function isClaimBody(value: unknown): value is ClaimBody {
	if (typeof value !== 'object' || value === null) return false
	const c = value as Partial<ClaimBody>
	return (
		typeof c.holder === 'string' && typeof c.expiresAt === 'number' && Number.isFinite(c.expiresAt)
	)
}

/**
 * The highest fence ever issued for this run, or 0 when it has never been
 * claimed.
 *
 * Reads names only. This is deliberately the one question the contended path
 * asks, because a name cannot be half-written: a file either exists or does
 * not, where a body can be observed mid-write.
 */
export async function currentFence(runDir: string): Promise<ClaimFence> {
	let names: string[]
	try {
		names = await readdir(join(runDir, CLAIMS_DIR))
	} catch (err) {
		if (isErrno(err, 'ENOENT')) return 0
		throw err
	}

	let max = 0
	for (const name of names) {
		if (!name.endsWith('.json')) continue
		const fence = Number(name.slice(0, -'.json'.length))
		// A name that is not a number is not a holding. Ignoring it cannot
		// lose a claim, because a claim this store issued is always numeric.
		if (Number.isInteger(fence) && fence > max) max = fence
	}
	return max
}

/**
 * The run's current holding, or `null` when it has never been claimed.
 *
 * Returns `null` for an unreadable body too, and that is safe HERE in a way
 * it was not in the previous design: the fence is known from the name
 * regardless, so an unreadable body means "somebody took this number and its
 * details are unavailable", and the caller's response is to take the NEXT
 * number rather than to give up. Nothing is inferred from the absence.
 */
export async function readClaim(runDir: string): Promise<RunClaim | null> {
	const fence = await currentFence(runDir)
	if (fence === 0) return null

	let raw: string
	try {
		raw = await readFile(join(runDir, CLAIMS_DIR, `${fence}.json`), 'utf-8')
	} catch (err) {
		// Gone between the listing and the read: somebody is mid-take. The
		// fence still stands, so report it as held-but-unknown.
		if (isErrno(err, 'ENOENT')) return { holder: '', fence, expiresAt: 0 }
		throw err
	}

	try {
		const parsed: unknown = JSON.parse(raw)
		if (isClaimBody(parsed)) return { holder: parsed.holder, fence, expiresAt: parsed.expiresAt }
	} catch {
		// fall through
	}

	// Unreadable body: the holding exists and its expiry is unknowable. Report
	// it as already expired so a sweep treats the run as available — it IS
	// available, because taking the next fence supersedes this holding whether
	// or not anybody is still behind it.
	return { holder: '', fence, expiresAt: 0 }
}

/** Take or extend the run's claim. `null` when somebody else holds it. */
export async function acquireClaim(
	runDir: string,
	options: ClaimRunOptions,
): Promise<RunClaim | null> {
	const now = options.now ?? Date.now()
	const claimsDir = join(runDir, CLAIMS_DIR)
	await mkdir(claimsDir, { recursive: true })

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const held = await readClaim(runDir)

		// Held, live, and by somebody else. Not an error: two readers on one
		// queue is the ordinary case.
		if (held && now < held.expiresAt && held.holder !== options.holder) return null

		const fence = (held?.fence ?? 0) + 1
		const body: ClaimBody = { holder: options.holder, expiresAt: now + options.ttlMs }

		try {
			// The one decision. Exactly one caller creates this name.
			await writeFile(join(claimsDir, `${fence}.json`), JSON.stringify(body), { flag: 'wx' })
			return { holder: options.holder, fence, expiresAt: body.expiresAt }
		} catch (err) {
			// Somebody else took this number. Re-read and decide again — they
			// may hold it live, in which case the next pass returns `null`.
			if (!isErrno(err, 'EEXIST')) throw err
		}
	}

	// Lost the create race MAX_ATTEMPTS times without ever reading a live
	// holder. Reporting "held" is the honest answer: something is taking this
	// run repeatedly and this caller is not winning.
	return null
}

/**
 * Give up a holding early, so the run returns to the queue without waiting
 * out its lease.
 *
 * Appends a tombstone at the next fence rather than deleting anything. The
 * counter must never rewind: a worker stalled at an old fence has to stay
 * fenced out forever, and removing the record would let a later claimer be
 * issued a number that stalled worker already believes it holds.
 *
 * A stale fence releases nothing — a worker that stalled past its lease must
 * not be able to hand away a run somebody else now holds.
 */
export async function releaseClaim(runDir: string, fence: ClaimFence): Promise<void> {
	const held = await readClaim(runDir)
	if (!held || held.fence !== fence) return

	const claimsDir = join(runDir, CLAIMS_DIR)
	const body: ClaimBody = { holder: '', expiresAt: 0 }
	try {
		await writeFile(join(claimsDir, `${fence + 1}.json`), JSON.stringify(body), { flag: 'wx' })
	} catch (err) {
		// Somebody already took the next fence, which means the run is claimed
		// again and there is nothing to release.
		if (!isErrno(err, 'EEXIST')) throw err
	}
}

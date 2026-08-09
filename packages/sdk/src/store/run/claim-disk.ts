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

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
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

/**
 * How many holdings to keep below the current fence.
 *
 * Append-only is right — a name that disappears can be re-issued — but
 * unbounded is not, and every operation lists this directory. Measured: 0.14
 * ms per operation at 10 holdings, 3.4 at 10,000, 78.6 at 200,000, and three
 * processes contending on ONE run produced 4,772 files in eight seconds. A
 * single holder renewing a 60-second lease produced 4,421. One busy run
 * reaches the 78 ms regime in minutes and drags the checkpoint write path of
 * every claimed run with it.
 *
 * Pruning BELOW the maximum is safe by the design own argument: a rewind
 * requires removing the highest name, and nothing reads a lower one — the
 * current holding is the maximum and the fence check compares against it. A
 * few are kept rather than none so an operator can still see the recent
 * handover history, which is the evidence a contested run is reconstructed
 * from.
 */
const KEEP_BELOW_MAX = 32

function isErrno(err: unknown, code: string): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

/** The stored body. The fence is the file name, not this. */
interface ClaimBody {
	readonly holder: string
	readonly expiresAt: number
	/**
	 * Set only on a release tombstone.
	 *
	 * One field, and it separates three states a listing previously could not
	 * tell apart: released cleanly, damaged beyond reading, and being written
	 * right now. All three are "take the next number" to a taker, and they
	 * are three different things to whoever is asked why a run stalled.
	 */
	readonly released?: boolean
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
/**
 * A holding's name: its fence, and nothing else.
 *
 * **The name must contain the fence ALONE.** Putting the expiry in it too was
 * tried, to close the window where `wx` has created the file and not yet
 * written its body — and it silently destroyed the exclusion this whole
 * design rests on. Two workers computing the same fence at different instants
 * produce different names, so both creates succeed and both hold fence N. The
 * race test caught it immediately: seventeen of three hundred runs went to
 * two or three workers.
 *
 * The lesson is worth more than the fix: the exclusive create is only
 * exclusive over the *exact* name, so anything varying in that name is a hole
 * in it. The empty-body window is handled by reading, not by naming — see
 * {@link readClaim}.
 *
 * Strict decimal, bounded to fifteen digits. `Number` accepts `0x10`, `" 7"`,
 * `08` and `1e21`, and above 2^53 or in exponent form `fence + 1 === fence` —
 * so a foreign writer could pin the counter and every taker after it would be
 * issued a fence EQUAL to the current one, which fences nobody out. Names
 * this store issues always match; anything else is not a holding, however
 * numeric it looks.
 */
const NAME = /^([0-9]{1,15})\.json$/

function nameFor(fence: ClaimFence): string {
	return `${fence}.json`
}

/** Every holding this run has on record, newest first. */
async function listHoldings(
	runDir: string,
): Promise<{ name: string; fence: ClaimFence; expiresAt: number }[]> {
	let names: string[]
	try {
		names = await readdir(join(runDir, CLAIMS_DIR))
	} catch (err) {
		if (isErrno(err, 'ENOENT')) return []
		throw err
	}

	const found: { name: string; fence: ClaimFence; expiresAt: number }[] = []
	for (const name of names) {
		const match = NAME.exec(name)
		if (!match) continue
		found.push({
			name,
			fence: Number(match[1]),
			expiresAt: 0,
		})
	}
	return found.sort((a, b) => b.fence - a.fence)
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
	const holdings = await listHoldings(runDir)
	return holdings[0]?.fence ?? 0
}

/**
 * Drop holdings far below the current fence.
 *
 * Only ever below the maximum. A rewind requires removing the HIGHEST name,
 * and nothing reads a lower one — the current holding is the maximum and the
 * write check compares against it — so this cannot re-issue a number. A
 * window of recent handovers is kept, because that is the evidence a
 * contested run gets reconstructed from.
 *
 * Failures are swallowed: pruning is housekeeping, and a run must not fail
 * because a tidy-up lost a race with another worker doing the same tidy-up.
 */
async function prune(claimsDir: string, max: ClaimFence): Promise<void> {
	const floor = max - KEEP_BELOW_MAX
	if (floor <= 0) return
	let names: string[]
	try {
		names = await readdir(claimsDir)
	} catch {
		return
	}
	for (const name of names) {
		const match = NAME.exec(name)
		if (!match) continue
		if (Number(match[1]) >= floor) continue
		await unlink(join(claimsDir, name)).catch(() => undefined)
	}
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
	const [top] = await listHoldings(runDir)
	if (!top) return null

	// The expiry comes from the NAME, so it is known the instant the file
	// exists — before its body is written. `wx` is open-then-write, and a
	// reader landing between the two used to see a holding it could not parse
	// and report it expired, which invited a second worker to take a live run.
	// Both would land on different fences, so the loser's first write is still
	// refused — but they would both have restored and RUN the tools by then,
	// and tool side effects are fenced by nothing.
	const claim: RunClaim = { holder: '', fence: top.fence, expiresAt: top.expiresAt }

	let raw: string
	try {
		raw = await readFile(join(runDir, CLAIMS_DIR, top.name), 'utf-8')
	} catch (err) {
		// Gone between the listing and the read: pruned, or mid-take. The name
		// already told us everything the taker needs.
		if (isErrno(err, 'ENOENT')) return claim
		throw err
	}

	try {
		const parsed: unknown = JSON.parse(raw)
		// The body is advisory now — it names the holder for an operator and
		// distinguishes a clean release from a damaged record. The two facts
		// the algorithm depends on are both in the name.
		if (isClaimBody(parsed)) {
			return { holder: parsed.holder, fence: top.fence, expiresAt: parsed.expiresAt }
		}
	} catch {
		// fall through: an unreadable body leaves the holding intact and
		// anonymous, which is what `holder: ''` says.
	}

	return claim
}

/**
 * Whether a holding is a clean release rather than a live or lapsed claim.
 *
 * A tombstone and a damaged record used to be byte-identical, so a listing
 * could not tell "released cleanly" from "this record is corrupt" from
 * "somebody is mid-take". Correct for the taker, which only needs the number,
 * and blind for the operator — in a repository whose premise is auditable
 * evidence.
 */
export async function isReleased(runDir: string): Promise<boolean> {
	const [top] = await listHoldings(runDir)
	if (!top) return false
	try {
		const parsed: unknown = JSON.parse(await readFile(join(runDir, CLAIMS_DIR, top.name), 'utf-8'))
		return typeof parsed === 'object' && parsed !== null && (parsed as ClaimBody).released === true
	} catch {
		return false
	}
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
			//
			// One name, one winner. The expiry lives only in the body; see the
			// note on NAME for why it must not appear here. Residual, and
			// accepted rather than hidden: `wx` is
			// open-then-write: between them the file exists and is empty, and
			// a reader landing there sees a holding it cannot parse. Reading
			// the expiry from the name makes that window harmless — the reader
			// gets the real deadline and waits, instead of treating a live
			// holding as expired and taking the run. Both workers would end up
			// on different fences, so the loser's first WRITE is still
			// refused; what is lost is exclusivity before that write, and a
			// run's tools have already executed by then. Tool side effects are
			// fenced by nothing. The reviewer could not observe this in 12,000
			// reads; it is recorded because a loaded CI box once did.
			await writeFile(join(claimsDir, nameFor(fence)), JSON.stringify(body), {
				flag: 'wx',
			})
			await prune(claimsDir, fence)
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
	// Expiry 0 in the name: free the instant it lands, with no body needed to
	// establish that. `released` in the body says WHY it is free.
	const body: ClaimBody = { holder: '', expiresAt: 0, released: true }
	try {
		await writeFile(join(claimsDir, nameFor(fence + 1)), JSON.stringify(body), { flag: 'wx' })
	} catch (err) {
		// Somebody already took the next fence, which means the run is claimed
		// again and there is nothing to release.
		if (!isErrno(err, 'EEXIST')) throw err
	}
}

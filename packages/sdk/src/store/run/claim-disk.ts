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
 * ## The name appears already complete, because `link` publishes it
 *
 * An exclusive create decides the winner, but `wx` is open-THEN-write: for an
 * instant the winning name exists and is empty. A reader landing in it parses
 * nothing, reports the holding expired, and a second worker takes the next
 * fence. Their fences differ so the loser's first checkpoint is refused — and
 * both have already restored the run and executed its tools by then, and tool
 * side effects are fenced by nothing.
 *
 * So the body is written to a temporary name first and the fence name is
 * created by `link`ing to it. `link` fails `EEXIST` when the destination
 * exists, so it arbitrates exactly as `wx` did, and the destination it creates
 * is a second name for a file that was already whole. There is no instant at
 * which the fence name exists and its body does not.
 *
 * Measured from separate OS processes on both platform families:
 *
 * - `link` refused an existing destination 20,000/20,000 times. Six writers
 *   over 6,000 fences produced no fence with two winners and none with none.
 * - Paired identical fixtures: `wx` showed an empty destination in 15,985 of
 *   16,000 first observations, `link` in 0 of 16,000. All 156,000 frontier
 *   observations were `ENOENT` or a complete parseable body — none empty, none
 *   torn.
 * - `rename` is disqualified, and not for the reason first assumed. It never
 *   reports `EEXIST`; it silently REPLACES, 20,000/20,000. It cannot arbitrate
 *   a race at all — two workers publishing one fence would both succeed and
 *   the second would erase the first. (Its `EPERM`-under-readers failure is
 *   real too, at 93.7% on the non-POSIX family, but the exclusivity failure
 *   disqualifies it first.)
 *
 * Cost: three syscalls rather than one, +1.0 ms per acquisition on the
 * non-POSIX family and +0.04 ms on POSIX, for an operation that runs once per
 * run plus renewals.
 *
 * ## What it still does not do
 *
 * It does not detect liveness. Nothing can from here: a stalled holder, a
 * suspended container and a partitioned network are indistinguishable, and
 * they are indistinguishable from the holder's own side too, which is why it
 * keeps writing. The fence is the answer — the write is checked, not the
 * writer.
 */

import { link, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NamzuError } from '../../types/errors/index.js'
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

/**
 * How old a scratch file must be before {@link prune} reclaims it.
 *
 * It brackets a `writeFile` of sixty-odd bytes and a `link`. Ten minutes is
 * four orders of magnitude more than that takes, and the asymmetry is the
 * point: reclaiming late costs a stale file until the next acquisition,
 * reclaiming early fails a live publish that did nothing wrong.
 */
const TEMP_TTL_MS = 10 * 60_000

function isErrno(err: unknown, code: string): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

/**
 * The stored body. The fence is the file name, not this.
 *
 * There is no `released` flag, and there was one. It existed so a listing
 * could tell a clean release from a damaged record, and **nothing ever asked**
 * — the only reader was an exported `isReleased` with no caller anywhere, not
 * re-exported from the package and absent from the public surface baseline.
 * `ClaimSummary`, which is the type a listing row actually carries, never
 * gained a field for it, so the distinction the flag was written for was never
 * available at the place it was meant to serve.
 *
 * Removed rather than wired, because the two states are the SAME ANSWER to
 * every caller there is: released, damaged and mid-take all mean "take the
 * next number". Wiring it would have added a public field and a fresh parity
 * obligation between the two shipped stores to carry a difference no consumer
 * can act on — surface to keep correct forever for nobody.
 *
 * An operator still has the distinction where operators actually work, on the
 * disk: a tombstone is valid JSON with an empty `holder` and an `expiresAt` of
 * 0, and a damaged record does not parse.
 */
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
 * A holding's name: its fence, and nothing else.
 *
 * **The destination name must be a pure function of the fence.** Putting the
 * expiry in it too was tried, to close the window where `wx` has created the
 * file and not yet written its body — and it silently destroyed the exclusion
 * this whole design rests on. Two workers computing the same fence at
 * different instants produce different names, so both creates succeed and
 * both hold fence N. The race test caught it immediately: seventeen of three
 * hundred runs went to two or three workers.
 *
 * **The temporary name must be the exact opposite — unique per attempt.** See
 * {@link tempNameFor}. The two rules are mirror images, and the pair is the
 * insight: an exclusive create is exclusive over the *exact* name, so the name
 * that has to arbitrate must not vary, and the name that must never arbitrate
 * must never repeat.
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

/**
 * The scratch name a body is written to before {@link publish} links it into
 * place. Never a holding — the leading dot and the dashes cannot match
 * {@link NAME}, so no listing can mistake one for a claim.
 */
const TEMP = /^\.tmp-/

/** Distinguishes two attempts inside one process; the pid does the rest. */
let attempts = 0

/**
 * A scratch name: unique per attempt, and deliberately NOT a function of the
 * fence.
 *
 * This is the mirror of the rule on {@link NAME}, and it was measured by
 * building it wrong on purpose. A temp named for the fence — the obvious
 * choice, since that is what is being published — fails **silently** on POSIX:
 * two workers write the same scratch path, one links the other's body, and 19
 * of 20,000 fences published a body belonging to a process that did not win
 * that name. The ledger looked perfect throughout: right count, no doubles,
 * none missing, every body parseable. Only reading a body back and comparing
 * its holder reveals it. On the non-POSIX family the same mistake crashed
 * three of six writer processes with `EPERM`.
 *
 * So: pid to separate processes, a counter to separate attempts within one,
 * and randomness to separate processes that share a pid across a container
 * restart or a pid-namespace reuse.
 *
 * The fence is on the end as well, and it is the one part carrying no
 * uniqueness — it is there so an operator reading a leaked scratch file can
 * tell which publish abandoned it. Uniqueness comes entirely from the three
 * parts before it, which is what keeps this the mirror of {@link NAME} rather
 * than a second copy of it. Anything appended for a human must stay in that
 * position: informative, and load-bearing for nothing.
 *
 * **The scratch file must live in the same directory as its destination.**
 * `link` across filesystems fails `EXDEV` — measured, not assumed — so a temp
 * directory anywhere else (`os.tmpdir()` being the tempting one) breaks every
 * acquisition the moment the store's base directory is a mount of its own.
 * That is a rule, not a preference.
 */
function tempNameFor(fence: ClaimFence): string {
	attempts += 1
	return `.tmp-${process.pid}-${attempts}-${Math.random().toString(36).slice(2, 10)}-${fence}`
}

/**
 * Codes a filesystem with no hard-link support answers `link` with.
 *
 * `EXDEV` is in the list as a bug report rather than a platform limit: it can
 * only mean the scratch file was moved out of the claims directory, against
 * the rule on {@link tempNameFor}.
 */
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

/**
 * Write `body` and make it visible at `fence` — completely, or not at all.
 *
 * Throws an `EEXIST` `ErrnoException` when another caller already published
 * that fence. That is the arbitration, and it is the caller's ordinary signal,
 * not a fault.
 *
 * Some filesystems — a few network and removable volumes — support no hard
 * link at all. **This refuses rather than falling back**, per
 * [refuse-do-not-degrade](../../../../../docs/conventions/refuse-do-not-degrade.md).
 * The only available fallback is the `wx` publish this replaced, and that one
 * carries the defect described in the module header: two workers restore and
 * run the same run. A claim that silently becomes non-exclusive is worse than
 * one that will not start, because the host cannot tell which it got — and a
 * host told plainly that this volume cannot arbitrate can move the base
 * directory or keep one writer per run. It is unmeasured, because no such
 * volume was available to measure; the error says so rather than implying a
 * diagnosis it did not make.
 */
async function publish(claimsDir: string, fence: ClaimFence, body: ClaimBody): Promise<void> {
	const tmp = join(claimsDir, tempNameFor(fence))

	try {
		await writeFile(tmp, JSON.stringify(body), { flag: 'wx' })
	} catch (err) {
		// A scratch name that already exists means the uniqueness rule on
		// `tempNameFor` has been broken. Letting an `EEXIST` escape from HERE
		// would read to the caller as "somebody else took this fence" — a lost
		// race it never had — so it is renamed into what it actually is.
		if (isErrno(err, 'EEXIST')) {
			throw new NamzuError({
				code: 'storage_error',
				message: `acquireClaim: the scratch name ${tmp} already exists. Scratch names must be unique per attempt; a collision means two publishes are sharing one, which lets a claim publish a body it did not write. See the rule on \`tempNameFor\`.`,
				details: { path: tmp, fence },
				retryable: false,
			})
		}
		// Anything else — no permission on the directory, a full disk, a
		// read-only mount — escapes as a bare errno naming a dotted temporary
		// file, with nothing in it about claims or runs. This write is the
		// first thing that touches the directory, so it is where a
		// misconfigured deployment surfaces, and `EPERM: open
		// '…/.tmp-4131-2-k3f9a1x8-1'` is the least useful place to find out.
		//
		// Wrapped for the same reason as the `link` failure below it: the
		// operator needs the run, the directory and the operation, not the
		// scratch name this attempt happened to draw.
		throw new NamzuError({
			code: 'storage_error',
			message: `acquireClaim: could not write a claim into ${claimsDir} (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}). This is the run's claim directory, and taking a run writes to it — check that the process can create files there. Refusing rather than proceeding: a claim that cannot be recorded is a claim nobody else can be refused against.`,
			details: { path: claimsDir, code: (err as NodeJS.ErrnoException).code, fence },
			cause: err,
			retryable: false,
		})
	}

	try {
		// The one decision. Exactly one caller creates this name, and the file
		// it names is already whole.
		await link(tmp, join(claimsDir, nameFor(fence)))
	} catch (err) {
		if (isErrno(err, 'EEXIST')) throw err
		const code = (err as NodeJS.ErrnoException).code
		if (code !== undefined && NO_LINK.has(code)) {
			throw new NamzuError({
				code: 'capability_unavailable',
				message: `acquireClaim: this filesystem answered \`link\` with ${code}, so it cannot publish a run claim. The claim decides which of two workers owns a run by exclusively creating a hard link, and a filesystem without hard links cannot make that decision. Refusing rather than degrading: the only fallback is a non-atomic create, under which two workers both restore the run and both execute its tools with nothing fencing the side effects. Put the store's base directory on a filesystem with hard-link support (${claimsDir}), or run a single writer per run.`,
				details: { path: claimsDir, code, fence },
				retryable: false,
			})
		}
		throw err
	} finally {
		// The link, if it landed, is an independent name for the same file.
		// Failure here leaks a scratch file and nothing else; `prune` sweeps
		// it, and no listing can mistake it for a holding.
		await unlink(tmp).catch(() => undefined)
	}
}

/**
 * Every holding this run has on record, newest first.
 *
 * Names only — no expiry. It used to report `expiresAt: 0` alongside each
 * name, which read as data and was a placeholder: the expiry has never been in
 * the name since the fence became the whole of it. A caller that wants a
 * deadline has to read the body, and {@link readClaim} is the only thing that
 * does.
 */
async function listHoldings(runDir: string): Promise<{ name: string; fence: ClaimFence }[]> {
	let names: string[]
	try {
		names = await readdir(join(runDir, CLAIMS_DIR))
	} catch (err) {
		if (isErrno(err, 'ENOENT')) return []
		throw err
	}

	const found: { name: string; fence: ClaimFence }[] = []
	for (const name of names) {
		const match = NAME.exec(name)
		if (!match) continue
		found.push({ name, fence: Number(match[1]) })
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
	let names: string[]
	try {
		names = await readdir(claimsDir)
	} catch {
		return
	}

	const floor = max - KEEP_BELOW_MAX
	// Real time, deliberately, and not the caller's `now`. A lease clock is
	// injectable so a test can age a claim out in one tick; the age of a file
	// on disk is a question about the wall clock, and judging one with the
	// other would let a test with `now: 1000` sweep every scratch file on the
	// volume.
	const wallClock = Date.now()

	for (const name of names) {
		const match = NAME.exec(name)
		if (match) {
			if (floor <= 0) continue
			if (Number(match[1]) >= floor) continue
			await unlink(join(claimsDir, name)).catch(() => undefined)
			continue
		}
		if (!TEMP.test(name)) continue

		// A crash between the scratch write and its unlink leaves one behind.
		// It can never be read as a holding — the name cannot match `NAME` —
		// but nothing reclaimed it either, so a run whose worker crashes in
		// that window accumulated scratch files forever.
		//
		// By age, because ownership is unknowable: another process may be
		// publishing through this very file right now, and unlinking it would
		// fail its `link` for no reason. The threshold is enormous relative to
		// the work it brackets — a `writeFile` of sixty-odd bytes followed by a
		// `link` — so a scratch file this old belongs to a process that is not
		// coming back.
		const path = join(claimsDir, name)
		try {
			const info = await stat(path)
			if (wallClock - info.mtimeMs < TEMP_TTL_MS) continue
		} catch {
			continue
		}
		await unlink(path).catch(() => undefined)
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

	// Fence from the name, expiry only from the body — and an expiry of 0 says
	// "no deadline could be established", which every caller reads as expired.
	//
	// This comment used to claim the expiry came from the name too, and was
	// therefore known the instant the file existed. It was stale by a
	// redesign, and it described the file's one real defect as handled: under
	// the old `wx` publish a reader could land on a created-but-empty file,
	// fail to parse it, and report a LIVE holding expired — which invited a
	// second worker onto a running run. Both restored it and executed its
	// tools before either was refused at its first checkpoint.
	//
	// What makes falling back safe now is the publish, not the naming: `link`
	// makes the fence name appear complete or not at all, so an unparseable
	// body means a genuinely damaged record rather than one being written. A
	// damaged record SHOULD read as reclaimable — refusing to take it is what
	// leaves a run permanently unclaimable, which is the failure a lease
	// exists to prevent — and the taker is safe regardless, because it takes
	// the next fence and the write check compares numbers.
	const claim: RunClaim = { holder: '', fence: top.fence, expiresAt: 0 }

	let raw: string
	try {
		raw = await readFile(join(runDir, CLAIMS_DIR, top.name), 'utf-8')
	} catch (err) {
		// Gone between the listing and the read. The name already told us
		// everything the taker needs.
		//
		// Only `ENOENT` is tolerated, and on the non-POSIX family that is not
		// the only code a vanishing file produces: a file already unlinked but
		// still open elsewhere is delete-pending, and a reader gets `EPERM` —
		// 4.6% of misses, measured. It cannot be reached from here today,
		// because `prune` only unlinks fences far below the top and this reads
		// only the top. Widen either one and this throws where it should
		// return. Whoever does that should extend this catch, not delete the
		// comment.
		if (isErrno(err, 'ENOENT')) return claim
		throw err
	}

	try {
		const parsed: unknown = JSON.parse(raw)
		// The body is advisory now — it names the holder for an operator and
		// distinguishes a clean release from a damaged record. The two facts
		// the algorithm depends on are both in the name.
		if (isClaimBody(parsed)) {
			return {
				holder: parsed.holder,
				fence: top.fence,
				expiresAt: parsed.expiresAt,
			}
		}
	} catch {
		// fall through: an unreadable body leaves the holding intact and
		// anonymous, which is what `holder: ''` says.
	}

	return claim
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
		const body: ClaimBody = {
			holder: options.holder,
			expiresAt: now + options.ttlMs,
		}

		try {
			// One name, one winner, and the winner's body is already whole
			// when the name appears. The expiry lives only in the body; see
			// the note on NAME for why it must not appear in the name.
			await publish(claimsDir, fence, body)
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
	// Expiry 0 and no holder: free the instant it lands. That pair IS the
	// tombstone — an empty holder with a zero expiry is not a shape a live
	// claim can take, so it reads as a clean handover to anyone looking at the
	// directory, without a flag no caller consumes. See {@link ClaimBody}.
	//
	// Published the same way as a claim, so nothing can catch it half-written.
	const body: ClaimBody = { holder: '', expiresAt: 0 }
	try {
		await publish(claimsDir, fence + 1, body)
	} catch (err) {
		// Somebody already took the next fence, which means the run is claimed
		// again and there is nothing to release.
		if (!isErrno(err, 'EEXIST')) throw err
	}
}

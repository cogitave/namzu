import { link, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionLeaseDocument } from '../../types/session/records.js'
import { durableReplaceFile } from './spill.js'

/**
 * The writer lease of one session: who may append, under which fence, until
 * when.
 *
 * ## The fence
 *
 * A fence is a number that only grows. Every new holding of a session mints a
 * fence above every earlier one, and every record carries the fence of the
 * lease its writer held as `gen`. An append presents its lease, and a lease
 * below the session's current fence is refused (`StaleSessionLeaseError`). So
 * a holder that stalled past its expiry — a long GC pause, a suspended
 * container — cannot write after somebody else took the session over, and it
 * finds out at its next append rather than never.
 *
 * ## On disk: the fence is a file name, `lease.json` is the view
 *
 * `<session-id>/lease.<fence>.json` is created by writing the body to a
 * private temporary file and `link`ing it into place. `link` fails with
 * `EEXIST` if the name exists, so of any number of simultaneous takers exactly
 * one wins each fence, and the name never exists without its whole body. This
 * is the arbitration `store/run/claim-disk.ts` measured and settled on; its
 * header records why a single mutable file with a lock, `wx` and `rename`
 * each fail to arbitrate. The current holding is the highest fence.
 *
 * `<session-id>/lease.json` is then replaced (fsynced temporary, rename) with
 * the same body plus `v`, `kind` and `fence`, for a person or a tool to read.
 * It is a view: under a race an older holding's rename can land after a newer
 * one's, so nothing that decides anything reads it. {@link readSessionLease}
 * reads the fence names.
 *
 * Renewing keeps the fence and rewrites that fence's body. A renewal that
 * loses a race with a taker — the taker judged the lease expired a moment
 * before the renewal landed — finds the higher fence afterwards and reports
 * the lease lost, and the fence check refuses its appends either way.
 *
 * Releasing publishes a tombstone at the next fence (empty holder, expiry 0),
 * so the counter never rewinds and the releasing holder's own fence is stale
 * the instant the release lands.
 *
 * ## Who renews, and when a new fence is minted
 *
 * Both stores apply one rule ({@link LeaseClaimContext}):
 *
 * - **Renewal is by presentation.** A claim renews only when it presents the
 *   holding it has (`renew`) and that holding is still the top fence under
 *   the same holder. The holder string alone never renews: a second instance
 *   or a restarted process that reuses a name gets `null` while the lease is
 *   live, exactly as a different holder would. A renewal keeps its fence even
 *   when it arrives after the expiry, provided nobody took the session in
 *   between — the fence did not move, so no other writer can have appended,
 *   and the holder's turn is still its own (spec §4.5 "running").
 * - **A new fence is above everything seen.** It is one more than the higher
 *   of the top lease fence and `above`, which the log passes as its head's
 *   `gen`. So a lost or cleared `<session-id>/` directory cannot rewind the
 *   fence below records already written.
 */

/** A holding of a session's writer lease. */
export interface SessionLease {
	/** Opaque caller identity (a worker id, a pod name). Evidence, not authority; make it unique per process. */
	readonly holder: string
	/** The fencing token; every record appended under this lease carries it as `gen`. */
	readonly fence: number
	/** Epoch ms after which another holder may take the session. */
	readonly expiresAt: number
}

export interface ClaimSessionOptions {
	readonly holder: string
	readonly ttlMs: number
	/** Clock, for tests. Defaults to `Date.now()`. */
	readonly now?: number
}

/** An append or a release presented a lease that is no longer the session's current one. */
export class StaleSessionLeaseError extends Error {
	override readonly name = 'StaleSessionLeaseError'
	constructor(
		readonly presentedFence: number,
		readonly currentFence: number,
		holder?: string,
	) {
		super(
			`The lease at fence ${presentedFence} is no longer this session's writer lease (the current fence is ${currentFence}${holder ? `, held by "${holder}"` : ''}). Another writer has taken the session over; refusing the write.`,
		)
	}
}

/** What a log adds to a claim: the holding it presents, and the fence floor its records set. */
export interface LeaseClaimContext {
	/**
	 * The holding the claimant has. The claim renews it (same fence) when it is
	 * still the top fence under `options.holder`; without it a live lease is
	 * never renewed, whoever holds it.
	 */
	readonly renew?: SessionLease
	/** A minted fence is above this (the log head's `gen`). Default 0. */
	readonly above?: number
}

/** Where a backend keeps its leases. */
export interface SessionLeaseStore {
	/**
	 * Take or renew the lease. `null` when it is live and the claim does not
	 * present it (see {@link LeaseClaimContext}).
	 */
	claim(options: ClaimSessionOptions, context?: LeaseClaimContext): Promise<SessionLease | null>
	/** Give the lease up early. A stale lease releases nothing. */
	release(lease: SessionLease): Promise<void>
	/** The current holding, or `null` when the session was never claimed. */
	current(): Promise<SessionLease | null>
	/** The current fence (0 when never claimed), from the cheapest source the backend has. */
	fence(): Promise<number>
}

/** Whether `lease` is live at `now`: not expired, and not a release tombstone. */
export function isLeaseLive(lease: SessionLease | null, now: number): boolean {
	return lease !== null && lease.holder !== '' && now < lease.expiresAt
}

type ClaimDecision =
	| { readonly kind: 'renew'; readonly fence: number }
	| { readonly kind: 'refuse' }
	| { readonly kind: 'mint'; readonly fence: number }

/** The one claim rule both stores apply (see the module header). */
function decideClaim(
	held: SessionLease | null,
	options: ClaimSessionOptions,
	context: LeaseClaimContext,
	now: number,
): ClaimDecision {
	const above = context.above ?? 0
	const renew = context.renew
	const presented =
		held !== null &&
		renew !== undefined &&
		held.holder !== '' &&
		held.fence === renew.fence &&
		held.holder === renew.holder &&
		held.holder === options.holder
	if (presented && held.fence >= above) return { kind: 'renew', fence: held.fence }
	if (!presented && isLeaseLive(held, now)) return { kind: 'refuse' }
	return { kind: 'mint', fence: Math.max(held?.fence ?? 0, above) + 1 }
}

// ─── disk ─────────────────────────────────────────────────────────────────

const FENCE_NAME = /^lease\.([0-9]{1,15})\.json$/
const TEMP_NAME = /^\.lease-tmp-/
/** Holdings kept below the current fence, as handover history for an operator. */
const KEEP_BELOW_MAX = 8
/** A scratch file older than this belongs to a process that is not coming back. */
const TEMP_TTL_MS = 10 * 60_000

interface LeaseBody {
	readonly holder: string
	readonly expiresAt: number
}

function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === code
}

let attempts = 0

function tempName(fence: number): string {
	attempts += 1
	return `.lease-tmp-${process.pid}-${attempts}-${Math.random().toString(36).slice(2, 10)}-${fence}`
}

/** Leases in `<session-id>/`, correct across processes. */
export class DiskSessionLeaseStore implements SessionLeaseStore {
	constructor(readonly sessionDir: string) {}

	async #fences(): Promise<{ name: string; fence: number }[]> {
		let names: string[]
		try {
			names = await readdir(this.sessionDir)
		} catch (error) {
			if (isErrno(error, 'ENOENT')) return []
			throw error
		}
		const found: { name: string; fence: number }[] = []
		for (const name of names) {
			const match = FENCE_NAME.exec(name)
			if (match) found.push({ name, fence: Number(match[1]) })
		}
		return found.sort((a, b) => b.fence - a.fence)
	}

	async fence(): Promise<number> {
		return (await this.#fences())[0]?.fence ?? 0
	}

	async current(): Promise<SessionLease | null> {
		const [top] = await this.#fences()
		if (top === undefined) return null
		try {
			const body = JSON.parse(await readFile(join(this.sessionDir, top.name), 'utf8')) as LeaseBody
			if (typeof body.holder === 'string' && Number.isFinite(body.expiresAt)) {
				return { holder: body.holder, fence: top.fence, expiresAt: body.expiresAt }
			}
		} catch {
			// An unreadable body: the fence is known from the name, the holding is anonymous.
		}
		return { holder: '', fence: top.fence, expiresAt: 0 }
	}

	/** Write `body` and make it visible at `fence`, whole or not at all. Throws `EEXIST` on a lost race. */
	async #publish(fence: number, body: LeaseBody): Promise<void> {
		const temporary = join(this.sessionDir, tempName(fence))
		await writeFile(temporary, JSON.stringify(body), { flag: 'wx' })
		try {
			await link(temporary, join(this.sessionDir, `lease.${fence}.json`))
		} finally {
			await unlink(temporary).catch(() => undefined)
		}
	}

	async #writeView(lease: SessionLease): Promise<void> {
		const view: SessionLeaseDocument = {
			v: 1,
			kind: 'lease',
			holder: lease.holder === '' ? 'released' : lease.holder,
			fence: lease.fence,
			expiresAt: new Date(lease.expiresAt).toISOString(),
		}
		await durableReplaceFile(join(this.sessionDir, 'lease.json'), `${JSON.stringify(view)}\n`)
	}

	async claim(
		options: ClaimSessionOptions,
		context: LeaseClaimContext = {},
	): Promise<SessionLease | null> {
		const now = options.now ?? Date.now()
		await mkdir(this.sessionDir, { recursive: true })
		for (let attempt = 0; attempt < 8; attempt++) {
			const held = await this.current()
			const decision = decideClaim(held, options, context, now)
			if (decision.kind === 'refuse') return null
			const body: LeaseBody = { holder: options.holder, expiresAt: now + options.ttlMs }
			if (decision.kind === 'renew') {
				// Same fence, new expiry. A taker that read the old body in the
				// meantime publishes a higher fence, which the check below sees.
				await durableReplaceFile(
					join(this.sessionDir, `lease.${decision.fence}.json`),
					JSON.stringify(body),
				)
				if ((await this.fence()) !== decision.fence) return null
				const renewed = { holder: options.holder, fence: decision.fence, expiresAt: body.expiresAt }
				await this.#writeView(renewed)
				return renewed
			}
			try {
				await this.#publish(decision.fence, body)
			} catch (error) {
				if (isErrno(error, 'EEXIST')) continue
				throw error
			}
			const lease = { holder: options.holder, fence: decision.fence, expiresAt: body.expiresAt }
			await this.#writeView(lease)
			await this.#prune(decision.fence)
			return lease
		}
		return null
	}

	async release(lease: SessionLease): Promise<void> {
		const current = await this.fence()
		if (current !== lease.fence) return
		const tombstone: SessionLease = { holder: '', fence: lease.fence + 1, expiresAt: 0 }
		try {
			await this.#publish(tombstone.fence, { holder: '', expiresAt: 0 })
		} catch (error) {
			if (isErrno(error, 'EEXIST')) return
			throw error
		}
		await this.#writeView(tombstone)
	}

	/** Drop holdings far below the current fence and scratch files a crash left. Never the top. */
	async #prune(max: number): Promise<void> {
		let names: string[]
		try {
			names = await readdir(this.sessionDir)
		} catch {
			return
		}
		const wallClock = Date.now()
		for (const name of names) {
			const match = FENCE_NAME.exec(name)
			if (match) {
				if (Number(match[1]) < max - KEEP_BELOW_MAX) {
					await unlink(join(this.sessionDir, name)).catch(() => undefined)
				}
				continue
			}
			if (!TEMP_NAME.test(name)) continue
			const path = join(this.sessionDir, name)
			try {
				if (wallClock - (await stat(path)).mtimeMs < TEMP_TTL_MS) continue
			} catch {
				continue
			}
			await unlink(path).catch(() => undefined)
		}
	}
}

/** The current lease of a session directory, for a reader that holds none (a drain, a status view). */
export function readSessionLease(sessionDir: string): Promise<SessionLease | null> {
	return new DiskSessionLeaseStore(sessionDir).current()
}

// ─── in process ───────────────────────────────────────────────────────────

/** The lease of an in-memory session: the same rules, held in this process. */
export class InMemorySessionLeaseStore implements SessionLeaseStore {
	#current: SessionLease | null = null

	async fence(): Promise<number> {
		return this.#current?.fence ?? 0
	}

	async current(): Promise<SessionLease | null> {
		return this.#current
	}

	async claim(
		options: ClaimSessionOptions,
		context: LeaseClaimContext = {},
	): Promise<SessionLease | null> {
		const now = options.now ?? Date.now()
		const decision = decideClaim(this.#current, options, context, now)
		if (decision.kind === 'refuse') return null
		this.#current = {
			holder: options.holder,
			fence: decision.fence,
			expiresAt: now + options.ttlMs,
		}
		return this.#current
	}

	async release(lease: SessionLease): Promise<void> {
		if (this.#current?.fence !== lease.fence) return
		this.#current = { holder: '', fence: lease.fence + 1, expiresAt: 0 }
	}
}

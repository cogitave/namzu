/**
 * When the inbox is drained, and what a drain tells the screen.
 *
 * A turn appends its screened claims to the inbox as it settles and goes on.
 * Four things empty the inbox, none of them on a turn's critical path:
 *
 * - **Idle.** A while after a turn settles, if no turn has started since.
 * - **A turn starting.** After the turn has been dispatched, on a timer of
 *   zero, so the reply never waits for it. This is also what picks up what an
 *   earlier process left behind: the first turn of a new process drains it.
 * - **The session closing.** So a one-shot run leaves nothing behind.
 * - **The process starting.** If a turn exists to count the model's tokens
 *   on; otherwise it waits for the first turn.
 *
 * One drain runs at a time. A drain that changed something reports one line
 * per change to whoever listens (the terminal shows them as a quiet row).
 * Pure of the terminal: the clock and the timers are handed in.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { PromoteMemory, SessionId, TurnId } from '@namzu/sdk'

import { type CurationLogEntry, type MemoryCurator, holdsClaims } from './curator.js'
import type { DrainResult, MemoryInbox } from './inbox.js'

/** How long after a turn settles the idle drain waits. */
export const CURATION_IDLE_MS = 15_000

/** How long a closing session waits for the last drain. */
export const CURATION_DISPOSE_MS = 8_000

export type DrainReason = 'idle' | 'turn-start' | 'dispose' | 'start'

export interface CurationRuntimeDeps {
	readonly inbox: MemoryInbox
	readonly curator: MemoryCurator
	readonly setTimer: (run: () => void, ms: number) => unknown
	readonly clearTimer: (handle: unknown) => void
	/** The newest turn: whose ledger counts the model's tokens. Undefined before the first turn. */
	readonly turn: () => { readonly sessionId: SessionId; readonly turnId: TurnId } | undefined
	/** Whether a small model could be asked at all. Without one the drain needs no turn. */
	readonly hasSideModel: () => boolean
	/** Whether the person is using the terminal right now. Read at fire time; defaults to not. */
	readonly isBusy?: () => boolean
	readonly idleMs?: number
	/** The lines of a drain that changed something. */
	readonly onChange?: (lines: readonly string[]) => void
	/** Told how a drain ended, for a debug log; never shown. */
	readonly report?: (reason: DrainReason, result: DrainResult | 'skipped' | 'failed') => void
}

export class CurationRuntime {
	readonly #deps: CurationRuntimeDeps
	#timer: unknown = null
	#disposed = false
	#draining = 0

	constructor(deps: CurationRuntimeDeps) {
		this.#deps = deps
	}

	/** Whether a drain is in flight right now. */
	get draining(): boolean {
		return this.#draining > 0
	}

	#cancel(): void {
		if (this.#timer === null) return
		this.#deps.clearTimer(this.#timer)
		this.#timer = null
	}

	/** A turn appended to the inbox as it settled: arm the idle drain. */
	appended(): void {
		if (this.#disposed) return
		this.#cancel()
		this.#timer = this.#deps.setTimer(() => {
			this.#timer = null
			if (this.#deps.isBusy?.() === true) return this.#deps.report?.('idle', 'skipped')
			void this.drain('idle')
		}, this.#deps.idleMs ?? CURATION_IDLE_MS)
	}

	/** A turn is starting: the idle drain is off, and a drain is queued behind the dispatch. */
	turnStarted(): void {
		if (this.#disposed) return
		this.#cancel()
		this.#timer = this.#deps.setTimer(() => {
			this.#timer = null
			void this.drain('turn-start')
		}, 0)
	}

	/** The session opened. Drains now when a turn can carry the cost, else leaves it for the first turn. */
	start(): void {
		if (this.#disposed) return
		void this.drain('start')
	}

	/** Drain for the last time. Nothing is armed afterwards. */
	async dispose(): Promise<void> {
		if (this.#disposed) return
		this.#disposed = true
		this.#cancel()
		// A closing session does not wait on a slow model for ever.
		const closing = new AbortController()
		const timer = this.#deps.setTimer(
			() => closing.abort(new Error('Memory curation did not finish while closing.')),
			CURATION_DISPOSE_MS,
		)
		try {
			await this.drain('dispose', closing.signal)
		} finally {
			this.#deps.clearTimer(timer)
		}
	}

	/** Empty the inbox once. Never rejects. */
	async drain(reason: DrainReason, signal?: AbortSignal): Promise<DrainResult | undefined> {
		const { inbox, curator } = this.#deps
		const turn = this.#deps.turn()
		// A model call is charged to a turn; without one, and with a model that
		// could be asked, the entries wait for the first turn.
		if (turn === undefined && this.#deps.hasSideModel()) {
			this.#deps.report?.(reason, 'skipped')
			return undefined
		}
		this.#draining += 1
		try {
			const lines: string[] = []
			const result = await inbox.drain(async (entries) => {
				const out = await curator.curate(
					entries.map((entry) => entry.candidate),
					{
						// Without a side model nothing is charged, so these are never read.
						sessionId: (turn?.sessionId ?? '') as SessionId,
						turnId: (turn?.turnId ?? '') as TurnId,
						...(signal ? { signal } : {}),
					},
				)
				lines.push(...out.lines)
			})
			this.#deps.report?.(reason, result)
			if (lines.length > 0) this.#deps.onChange?.(lines)
			return result
		} catch {
			this.#deps.report?.(reason, 'failed')
			return undefined
		} finally {
			this.#draining -= 1
		}
	}
}

/**
 * The curation log: one JSON line per op. Ids and reason codes, never a claim,
 * a title or a conversation. A failure to write is swallowed; the log is a
 * record, not a dependency.
 */
/** The curation log writer; `settled()` resolves once every line written so far is on disk. */
export interface CurationLog {
	(entry: CurationLogEntry): void
	settled(): Promise<void>
}

export function createCurationLog(file: string): CurationLog {
	// One write at a time, in call order: two appends started together may land in either order.
	// The folder is made on the first write, never before: a session that logs nothing creates nothing.
	let tail: Promise<void> | undefined
	const write = (entry: CurationLogEntry): void => {
		const line = `${JSON.stringify(entry)}\n`
		tail ??= mkdir(dirname(file), { recursive: true, mode: 0o700 }).then(
			() => undefined,
			() => undefined,
		)
		tail = tail.then(() => appendFile(file, line, { mode: 0o600 })).catch(() => {})
	}
	return Object.assign(write, { settled: () => tail ?? Promise.resolve() })
}

/**
 * What a settling turn runs in place of the promoter: it appends the claims
 * to the inbox and arms the idle drain. A turn with no claim writes nothing.
 * If the inbox cannot be written, the claims go to `fallback` (the screened
 * promoter) so they are not lost.
 */
export function inboxPromotion(options: {
	readonly inbox: MemoryInbox
	readonly fallback: PromoteMemory
	readonly appended: () => void
}): PromoteMemory {
	return async (candidate) => {
		if (!holdsClaims(candidate)) return
		try {
			await options.inbox.append(candidate)
		} catch {
			await options.fallback(candidate)
			return
		}
		options.appended()
	}
}

/**
 * The promoter a session hands the kernel. With curation on: screen, then the
 * optional decision gate, then the inbox. With it off: the gate over the
 * screened promoter, which writes at settle with no inbox and no model.
 */
export function composeMemoryPromotion(options: {
	readonly curation: CurationRuntime | undefined
	readonly inbox: MemoryInbox
	/** The screened promoter: writes a record per claim set. */
	readonly written: PromoteMemory
	readonly screen: (promote: PromoteMemory) => PromoteMemory
	readonly gate: (promote: PromoteMemory) => PromoteMemory
}): PromoteMemory {
	const { curation } = options
	if (!curation) return options.gate(options.written)
	return options.screen(
		options.gate(
			inboxPromotion({
				inbox: options.inbox,
				fallback: options.written,
				appended: () => curation.appended(),
			}),
		),
	)
}

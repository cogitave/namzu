import type { RecordPointer } from '../../types/session/records.js'
import { type SessionLogEntry, SessionLogIntegrityError } from './chain.js'
import type { SessionLog } from './core.js'

/**
 * Reductions over a whole session log, advanced rather than recomputed.
 *
 * A session log only grows, and every turn asks it the same questions (which
 * checkpoints were committed, which turn ids exist, what the folded context
 * is). Answering each from byte 0 parses and verifies every record the
 * session ever wrote, so a turn cost more the longer the session. A reduction
 * held here remembers the last record it folded and, on the next ask, walks
 * only what was appended after it. `SessionLog.read({ after })` checks that
 * record against the log byte for byte before continuing, so a log that was
 * replaced, truncated or rewritten at that record is noticed and the
 * reduction starts again from byte 0 with the original behaviour (strict reads
 * refuse a broken chain, tolerant reads stop at the break).
 *
 * What a resumed read does not do is re-verify the records before the anchor:
 * they were verified when they were first folded, by this process. A byte
 * flipped in them afterwards, with every later record left as it was, is not
 * noticed by this path; a fresh process (a resume) always starts from byte 0.
 *
 * The cache is keyed by session id and the reduction's own name and mode,
 * holds a few sessions, and is anchored by content, so two logs that share a
 * session id never share a result.
 *
 * Cost that remains: the state of the "every message ever recorded" reduction
 * holds each message the log ever recorded, superseded and compacted ones
 * included, so it grows with the log and not with the live context, and it
 * lives for the life of the process (for the sessions kept). Reading it
 * returns a copy of all of them, which is O(history) per turn. Both are small
 * next to the whole-log walks this file removes, and are left as they are.
 * More than SESSIONS_KEPT sessions in use at once evict one another, and each
 * eviction restarts from byte 0, the cost before this file existed.
 */

const SESSIONS_KEPT = 4

interface Kept {
	state: unknown
	/** The last record folded; the next read resumes after it. */
	anchor: RecordPointer | undefined
	/** Calls on one reduction take turns: the state is advanced in place. */
	turn: Promise<unknown>
}

const sessions = new Map<string, Map<string, Kept>>()

function keptFor(sessionId: string, key: string): Kept {
	let reductions = sessions.get(sessionId)
	if (reductions === undefined) {
		reductions = new Map()
		if (sessions.size >= SESSIONS_KEPT) {
			const oldest = sessions.keys().next().value
			if (oldest !== undefined) sessions.delete(oldest)
		}
	} else {
		sessions.delete(sessionId)
	}
	sessions.set(sessionId, reductions)
	let kept = reductions.get(key)
	if (kept === undefined) {
		kept = { state: undefined, anchor: undefined, turn: Promise.resolve() }
		reductions.set(key, kept)
	}
	return kept
}

export interface IncrementalFold<S, R> {
	/** The reduction's name; one cache slot per name and read mode. */
	readonly name: string
	readonly mode: 'strict' | 'tolerant'
	/**
	 * Strict reductions only: before resuming, hash every byte before the
	 * resume point against what this process verified (`read({ reverify })`),
	 * so a resumed read refuses a log altered anywhere, as a read from byte 0
	 * does, without parsing the prefix again. Off by default: the window the
	 * header describes then applies.
	 */
	readonly reverify?: boolean
	/** A fresh, empty state. */
	create(): S
	/** Fold one record into the state, in place. */
	apply(state: S, entry: SessionLogEntry): void
	/**
	 * The answer, from a state that is current for as long as this call runs.
	 * It must not keep or hand out the state itself, which later calls advance.
	 */
	result(state: S): Promise<R> | R
}

/**
 * Fold `log` into `fold.create()` through `fold.apply`, resuming from the
 * record the previous call for this session stopped at when the log still
 * holds it, and answer with `fold.result`.
 */
export async function foldSessionLog<S, R>(
	log: SessionLog,
	fold: IncrementalFold<S, R>,
): Promise<R> {
	const kept = keptFor(log.sessionId, `${fold.name}:${fold.mode}`)
	const run = async (): Promise<R> => {
		let state = kept.state as S | undefined
		let anchor = kept.anchor
		for (let attempt = 0; attempt < 2; attempt++) {
			const resuming = state !== undefined && anchor !== undefined
			if (!resuming) {
				state = fold.create()
				anchor = undefined
			}
			let moved = false
			try {
				const walk = log.read({
					mode: fold.mode,
					...(anchor ? { after: anchor } : {}),
					...(anchor && fold.reverify && fold.mode === 'strict' ? { reverify: true } : {}),
				})
				let summary: Awaited<ReturnType<typeof walk.next>>
				for (;;) {
					summary = await walk.next()
					if (summary.done) break
					moved = true
					fold.apply(state as S, summary.value)
				}
				const ended = summary.value
				if (resuming && !moved && ended.break?.reason === 'anchor-mismatch') {
					kept.state = undefined
					kept.anchor = undefined
					state = undefined
					anchor = undefined
					continue
				}
				kept.state = state
				kept.anchor = ended.head?.pointer ?? anchor
				return await fold.result(state as S)
			} catch (error) {
				// The state may be half-advanced: never reuse it.
				kept.state = undefined
				kept.anchor = undefined
				if (
					resuming &&
					!moved &&
					error instanceof SessionLogIntegrityError &&
					error.reason === 'anchor-mismatch'
				) {
					state = undefined
					anchor = undefined
					continue
				}
				throw error
			}
		}
		throw new Error('unreachable')
	}
	const result = kept.turn.then(run, run)
	kept.turn = result.catch(() => undefined)
	return result
}

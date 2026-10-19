/**
 * Picking up a previous conversation from the command line.
 *
 * The store, the reader and the picker all existed; only the entry point was
 * missing, so a conversation you could resume inside the TUI could not be
 * resumed from a script.
 *
 * ## What happens when it cannot be done
 *
 * **It refuses, and names the cause. It never falls back to a new session.**
 *
 * Someone who types `--resume <id>` is asking for THAT conversation. The three
 * available answers are not equally good:
 *
 * - *Start fresh* is the worst. They asked for a specific thing, got a
 *   different thing that is indistinguishable from outside, and nothing
 *   failed — they find out several turns later, having already acted on an
 *   agent that has no idea what they are referring to.
 * - *Resume with whatever survived* is worse still. The agent gets a partial
 *   history and neither it nor the user knows which part is missing, so it acts
 *   confidently on a hole. A half-context is not a degraded context; it is a
 *   different context that lies about being complete.
 * - *Refuse* costs one command and loses nothing.
 *
 * The message names the CAUSE rather than the outcome, because the causes have
 * different next moves — a conversation belonging to another directory is
 * fixed with `--cwd`, and an empty store is not fixed at all. "Cannot resume"
 * alone sends someone hunting through a store that is fine.
 *
 * There is deliberately no way to spell "resume if you can, otherwise start".
 * If that is what you want, run the command with no flag. The absence of a
 * thing must not be spellable as a silent widening of it.
 */

import type { Message } from '@namzu/sdk'

import {
	type CliSessions,
	type RecentConversation,
	listRecent,
	loadResumableConversation,
} from '../integrations/sessions/store.js'

export interface ResumeRequest {
	/** `--continue`: the most recent conversation in this directory. */
	readonly continueLast: boolean
	/** `--resume <id>`: this conversation, and no other. */
	readonly sessionId: string | null
}

export type ResumeOutcome =
	| { readonly kind: 'fresh' }
	| { readonly kind: 'resumed'; readonly sessionId: string; readonly messages: readonly Message[] }
	| { readonly kind: 'error'; readonly message: string }

/**
 * Resolve what a `--continue` / `--resume` asked for.
 *
 * `cwd` is carried only so a refusal can name the directory it looked in — the
 * most common cause of "no previous session" is standing in the wrong one, and
 * a message that does not say where it looked cannot tell you that.
 */
export async function resolveResume(
	sessions: CliSessions | null,
	request: ResumeRequest,
	cwd: string,
): Promise<ResumeOutcome> {
	if (!request.continueLast && !request.sessionId) return { kind: 'fresh' }
	if (request.continueLast && request.sessionId) {
		return {
			kind: 'error',
			message:
				'--continue and --resume ask for different conversations: --continue takes the most recent, --resume takes the one you named. Pass one.',
		}
	}
	if (!sessions) {
		return {
			kind: 'error',
			message: `no conversation store in ${cwd} — it could not be opened, so there is nothing to resume`,
		}
	}

	if (request.continueLast) {
		let recent: RecentConversation[]
		try {
			recent = await listRecent(sessions, 50)
		} catch (err) {
			return {
				kind: 'error',
				message: `conversations in ${cwd} cannot be resumed: ${err instanceof Error ? err.message : String(err)}`,
			}
		}
		const latest = recent[0]
		if (!latest) {
			// Its own sentence, because the cause is different from a bad id and
			// so is the fix. Someone with no session here is usually standing in
			// the wrong directory, and `--cwd` is the next thing to try.
			return {
				kind: 'error',
				message: `no previous conversation in ${cwd} — run without --continue to start one, or pass --cwd if you meant a different directory`,
			}
		}
		return await load(sessions, latest.id, cwd)
	}

	const wanted = request.sessionId as string
	// An exact id is not a request for a row in the recent picker. The previous
	// implementation searched a 50-row list, so the 51st valid conversation was
	// reported missing even though its durable record was intact.
	return await load(sessions, wanted, cwd)
}

async function load(sessions: CliSessions, sessionId: string, cwd: string): Promise<ResumeOutcome> {
	let messages: readonly Message[]
	try {
		messages = await loadResumableConversation(sessions, sessionId)
	} catch (err) {
		// Reading the transcript failed after the conversation was found. NOT
		// recoverable by carrying on with an empty history: that is the
		// half-context case, and it would look to the user exactly like a
		// session that had been resumed.
		return {
			kind: 'error',
			message: `conversation "${sessionId}" could not be resumed in ${cwd}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		}
	}
	if (messages.length === 0) {
		return {
			kind: 'error',
			message: `conversation "${sessionId}" has no messages to resume — its transcript is empty`,
		}
	}
	return { kind: 'resumed', sessionId, messages }
}

/** What the interactive launch should do for `--continue` / `--resume [value]`. */
export type TuiResumeOutcome =
	| { readonly kind: 'fresh' }
	| { readonly kind: 'open'; readonly sessionId: string }
	/** Open the `/resume` picker once the screen is ready; `query` pre-filters it. */
	| { readonly kind: 'picker'; readonly query?: string }
	| { readonly kind: 'error'; readonly message: string }

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve the interactive `--continue` / `--resume [value]`.
 *
 * The reference terminal's rule: no value opens the picker; a value shaped
 * like a conversation id resumes that conversation or fails; any other value
 * resumes the one conversation whose title it matches exactly, and otherwise
 * opens the picker with the value as the search term. `--continue` takes the
 * most recent conversation in this project and fails when there is none.
 *
 * Unlike `exec`, the picker is a legitimate answer here: a person is looking
 * at the screen and chooses, so nothing is substituted silently.
 */
export async function resolveTuiResume(
	sessions: CliSessions | null,
	request: { readonly continueLast: boolean; readonly resume: string | true | null },
	cwd: string,
): Promise<TuiResumeOutcome> {
	const { continueLast, resume } = request
	if (!continueLast && resume === null) return { kind: 'fresh' }
	if (continueLast && resume !== null) {
		return {
			kind: 'error',
			message:
				'--continue and --resume ask for different conversations: --continue takes the most recent, --resume takes the one you named. Pass one.',
		}
	}
	if (resume === true) return { kind: 'picker' }
	if (continueLast || (resume !== null && CONVERSATION_ID.test(resume.trim()))) {
		const outcome = await resolveResume(
			sessions,
			{ continueLast, sessionId: continueLast ? null : (resume as string).trim() },
			cwd,
		)
		if (outcome.kind === 'resumed') return { kind: 'open', sessionId: outcome.sessionId }
		if (outcome.kind === 'error') return outcome
		return { kind: 'fresh' }
	}
	const term = (resume as string).trim()
	if (term === '') return { kind: 'picker' }
	if (!sessions) return { kind: 'picker', query: term }
	let recent: RecentConversation[] = []
	try {
		recent = await listRecent(sessions, 100)
	} catch {
		// The picker lists the same conversations and reports its own failure.
		return { kind: 'picker', query: term }
	}
	const named = recent.filter((c) => c.title === term)
	const only = named.length === 1 ? named[0] : undefined
	return only ? { kind: 'open', sessionId: only.id } : { kind: 'picker', query: term }
}

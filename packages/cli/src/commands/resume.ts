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
	loadConversation,
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

	const recent = await listRecent(sessions, 50)

	if (request.continueLast) {
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
		return await load(sessions, latest)
	}

	const wanted = request.sessionId as string
	const match = recent.find((c) => c.id === wanted)
	if (!match) {
		const known = recent.length
		return {
			kind: 'error',
			message:
				known === 0
					? `no conversation "${wanted}" in ${cwd}, and no others either — pass --cwd if you meant a different directory`
					: `no conversation "${wanted}" in ${cwd}. ${known} other${known === 1 ? '' : 's'} here; \`namzu history\` lists them`,
		}
	}
	return await load(sessions, match)
}

async function load(
	sessions: CliSessions,
	conversation: RecentConversation,
): Promise<ResumeOutcome> {
	let messages: readonly Message[]
	try {
		messages = await loadConversation(sessions, conversation.id)
	} catch (err) {
		// Reading the transcript failed after the conversation was found. NOT
		// recoverable by carrying on with an empty history: that is the
		// half-context case, and it would look to the user exactly like a
		// session that had been resumed.
		return {
			kind: 'error',
			message: `conversation "${conversation.id}" could not be read: ${
				err instanceof Error ? err.message : String(err)
			}`,
		}
	}
	if (messages.length === 0) {
		return {
			kind: 'error',
			message: `conversation "${conversation.id}" has no messages to resume — its transcript is empty`,
		}
	}
	return { kind: 'resumed', sessionId: conversation.id, messages }
}

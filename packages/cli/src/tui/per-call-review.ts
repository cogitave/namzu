/**
 * What the terminal tells the kernel when it asks about one call at a time.
 *
 * `perCallReview` is opt-in on the kernel side; the terminal opts in. This file
 * holds the three things the kernel cannot know about the screen: when the
 * person's rules or mode changed (so a question still open can be re-checked),
 * whether the mode now covers a call, and which calls must never be let through
 * by a re-check because their input was not shown in full.
 *
 * A re-check only ever approves. The kernel adds its own refusals on top of
 * these (a call that leaves the turn's boundary, one a tool says always needs
 * a person, one a rule asked about), so nothing here has to repeat them.
 */

import { ACCEPT_EDITS_TOOLS, type PermissionMode } from '../permissions/mode.js'
import type { PermissionDecision, PermissionToolCall } from './agent.js'

/** The person's own words about a refusal are cut at this many characters. */
export const REASON_MAX_CHARS = 500

/**
 * A typed reason made safe to print and to record: control characters
 * (an escape sequence among them) and line breaks become single spaces, the
 * ends are trimmed, and the length is capped by character, not by code unit.
 */
export function cleanReason(text: string): string {
	let out = ''
	let gap = false
	for (const ch of text) {
		const code = ch.codePointAt(0) as number
		const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f)
		if (control || ch === ' ') {
			gap = out.length > 0
			continue
		}
		if (gap) out += ' '
		gap = false
		out += ch
	}
	return Array.from(out).slice(0, REASON_MAX_CHARS).join('')
}

/**
 * What typing adds to a reason being written: control characters and line
 * breaks become spaces, and the whole is kept within {@link REASON_MAX_CHARS}.
 */
export function appendTypedReason(current: string, typed: string): string {
	let out = current
	let count = Array.from(current).length
	for (const ch of typed) {
		if (count >= REASON_MAX_CHARS) break
		const code = ch.codePointAt(0) as number
		const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f)
		if (control && ch !== '\n' && ch !== '\t') continue
		out += control ? ' ' : ch
		count += 1
	}
	return out
}

/** A plain No. In the person's own conversation it also ends the turn. */
export function plainNo(endsTurn: boolean): PermissionDecision {
	return { kind: 'reject', declined: {}, ...(endsTurn ? { endTurn: true as const } : {}) }
}

/** A No with the person's words: this call only, the model reads the reason and carries on. */
export function noWithReason(reason: string): PermissionDecision | undefined {
	const note = cleanReason(reason)
	if (note === '') return undefined
	return {
		kind: 'reject',
		feedback: `The user declined this and said: ${note}`,
		declined: { note },
	}
}

export interface PerCallReviewHost {
	/** The session's permission mode now. */
	readonly mode: () => PermissionMode
}

export interface TerminalPerCallReview {
	/** Pass this as the turn's `perCallReview`. */
	readonly config: import('@namzu/sdk').PerCallReviewConfig
	/** A rule was remembered or the mode changed: re-check every question still open. */
	readonly rulesChanged: () => void
	/** Remember that a call's input was not shown in full, so no re-check approves it. */
	readonly hold: (callId: string, notShownInFull: boolean) => void
	/** Forget a call once its question is over. */
	readonly release: (callId: string) => void
	/** Whether the current mode lets this call run without asking; also used for queued batches. */
	readonly modeCovers: (call: PermissionToolCall) => boolean
}

export function createTerminalPerCallReview(host: PerCallReviewHost): TerminalPerCallReview {
	const listeners = new Set<() => void>()
	const held = new Map<string, boolean>()
	const modeCovers = (call: PermissionToolCall): boolean => {
		if (call.requiresApproval === true || call.authorization?.explicitReview === true) return false
		if (call.escalation !== undefined) return false
		switch (host.mode()) {
			case 'bypass':
				return true
			case 'accept-edits':
				return ACCEPT_EDITS_TOOLS.has(call.name) && call.isDestructive !== true
			default:
				return false
		}
	}
	return {
		config: {
			onRulesChanged: (listener) => {
				listeners.add(listener)
				return () => {
					listeners.delete(listener)
				}
			},
			covers: (call) => modeCovers(call),
			// A call the terminal has not seen is held: a re-check keeps it open.
			neverCover: (call) => held.get(call.id) !== false,
		},
		rulesChanged: () => {
			for (const listener of [...listeners]) listener()
		},
		hold: (callId, notShownInFull) => {
			held.set(callId, notShownInFull)
		},
		release: (callId) => {
			held.delete(callId)
		},
		modeCovers,
	}
}

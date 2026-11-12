/**
 * A turn the model handed back to a person (`docs/sdk/hand-back.md`).
 *
 * The model calls `hand_back_task` when the task cannot be finished as
 * specified and the honest thing is to stop and say so. The turn ends there:
 * no further model call, nothing else runs. The fact is kept beside the
 * turn's outcome verdict, not inside it: a turn can have changed files and
 * still have been handed back.
 */

/** Why the model stopped; a small closed set so a script can branch on it. */
export type HandBackKind =
	/** The request conflicts with itself, or with the checks that decide whether it is done. */
	| 'conflict'
	/** Something needed is missing or not allowed: an input, a file, a credential, a permission. */
	| 'missing'
	/** A decision is needed that belongs to a person. */
	| 'decision'

export const HAND_BACK_KINDS: readonly HandBackKind[] = ['conflict', 'missing', 'decision']

/** What the model said when it handed the task back. The words are the model's. */
export interface HandBack {
	readonly kind: HandBackKind
	/** What blocks it. */
	readonly blocker: string
	/** What it tried. */
	readonly tried: string
	/** What a person has to decide or provide. */
	readonly needed: string
}

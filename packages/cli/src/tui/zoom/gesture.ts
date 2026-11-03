/**
 * The left-arrow gesture that opens the workspaces screen from a conversation.
 *
 * A single `←` on an empty composer fires. Two rules keep it from firing by
 * accident: a composer that was just emptied by editing only arms (the first `←`
 * shows a hint, a second one soon after fires), and presses that arrive as key
 * repeat or right after a fire or an arm are swallowed instead of counted.
 *
 * Pure logic with an injected clock; the composer feeds it presses and edits.
 */

/** A `←` closer than this to the previous one is the key repeating. */
export const REPEAT_MS = 150
/** A composer emptied by editing this recently only arms on the first `←`. */
export const EDITED_MS = 2000
/** After arming, a second `←` fires if it comes within this long. */
export const ARM_MS = 3000
/** Presses this soon after a fire or an arm are swallowed. */
export const COOLDOWN_MS = 1000

/** What the composer does with a `←` press. */
export type GestureVerdict =
	/** Open the workspaces screen. */
	| 'fire'
	/** Show the hint; the next `←` within the arm window fires. */
	| 'arm'
	/** Do nothing: key repeat, or too soon after the last fire or arm. */
	| 'swallow'
	/** Not this gesture: the key moves the cursor as usual. */
	| 'pass'

export interface GesturePress {
	/** The composer holds no text. */
	readonly empty: boolean
	/** Pasted or attached items are present. */
	readonly attachments: boolean
	readonly shift?: boolean
	readonly ctrl?: boolean
	readonly meta?: boolean
}

export class LeftGesture {
	private lastPress: number | undefined
	private lastActed: number | undefined
	private emptiedAt: number | undefined
	private armedAt: number | undefined

	constructor(private readonly now: () => number = Date.now) {}

	/** The composer went from holding text to being empty through editing. */
	noteEmptied(): void {
		this.emptiedAt = this.now()
		this.armedAt = undefined
	}

	/** The composer holds text again: whatever was armed is dropped. */
	noteFilled(): void {
		this.emptiedAt = undefined
		this.armedAt = undefined
	}

	press(press: GesturePress): GestureVerdict {
		if (!press.empty || press.attachments || press.shift || press.ctrl || press.meta) return 'pass'
		const at = this.now()
		const previous = this.lastPress
		this.lastPress = at
		if (previous !== undefined && at - previous < REPEAT_MS) return 'swallow'
		if (this.lastActed !== undefined && at - this.lastActed < COOLDOWN_MS) return 'swallow'
		const armed = this.armedAt !== undefined && at - this.armedAt <= ARM_MS
		if (!armed && this.emptiedAt !== undefined && at - this.emptiedAt < EDITED_MS) {
			this.armedAt = at
			this.lastActed = at
			return 'arm'
		}
		this.armedAt = undefined
		this.emptiedAt = undefined
		this.lastActed = at
		return 'fire'
	}
}

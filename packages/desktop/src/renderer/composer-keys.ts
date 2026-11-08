import { caretAtEdge } from './composer-history.js'

/** What a key press in the message box means. */
export type ComposerKey =
	| { action: 'none' }
	| { action: 'edit-queued' }
	| { action: 'recall'; direction: 'older' | 'newer' }
	| { action: 'queue' }
	| { action: 'send' }

export interface ComposerKeyInput {
	key: string
	shiftKey: boolean
	altKey: boolean
	ctrlKey: boolean
	metaKey: boolean
	/** The browser flag, or the legacy key code 229 some input methods send instead. */
	composing: boolean
	value: string
	selectionStart: number
	selectionEnd: number
	hasDraft: boolean
	/** A waiting message can be taken back to edit. */
	editableQueued: boolean
	trayEditing: boolean
	/** Earlier messages exist to walk through. */
	hasHistory: boolean
	/** The box shows a message recalled from the history. */
	walking: boolean
	/** A reply is running and the engine takes a new message into it, so a message can be held. */
	canHold: boolean
}

/**
 * An input method that is composing text owns every key: Enter confirms the candidate, the arrows
 * pick one. The flag is not always set on the confirming key, which then reports key code 229.
 */
export function isComposing(event: {
	isComposing?: boolean
	keyCode?: number
	nativeEvent?: { isComposing?: boolean; keyCode?: number }
}): boolean {
	return (
		event.isComposing === true ||
		event.nativeEvent?.isComposing === true ||
		event.keyCode === 229 ||
		event.nativeEvent?.keyCode === 229
	)
}

const plain = (input: ComposerKeyInput) =>
	!input.shiftKey && !input.altKey && !input.ctrlKey && !input.metaKey

/**
 * Decides one key press in the message box. The hold chord (Ctrl or Cmd with Enter) lives here,
 * on the box, and nowhere wider: the approval card has its own Ctrl+Enter, which answers it, and
 * a key pressed in the box must never reach it.
 */
export function decideComposerKey(input: ComposerKeyInput): ComposerKey {
	if (input.composing) return { action: 'none' }
	if (input.key === 'ArrowUp' && plain(input)) {
		// An empty box takes the newest waiting message back first; the history comes after.
		if (!input.hasDraft && input.editableQueued && !input.trayEditing)
			return { action: 'edit-queued' }
		if (
			input.hasHistory &&
			caretAtEdge(input.value, input.selectionStart, input.selectionEnd, 'older')
		)
			return { action: 'recall', direction: 'older' }
		return { action: 'none' }
	}
	if (
		input.key === 'ArrowDown' &&
		plain(input) &&
		input.walking &&
		caretAtEdge(input.value, input.selectionStart, input.selectionEnd, 'newer')
	)
		return { action: 'recall', direction: 'newer' }
	// Tab holds what is typed for after this reply, as in the terminal.
	if (input.key === 'Tab' && plain(input) && input.canHold) return { action: 'queue' }
	if (input.key === 'Enter' && !input.shiftKey) {
		if ((input.ctrlKey || input.metaKey) && !input.altKey && input.canHold)
			return { action: 'queue' }
		return { action: 'send' }
	}
	return { action: 'none' }
}

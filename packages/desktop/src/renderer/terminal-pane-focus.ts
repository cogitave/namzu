/** What a click inside a terminal pane may do to the keyboard. */

const CONTROLS = 'button, input, a, textarea, select'

/**
 * A press on the pane's own surface (padding, a note, the gap round the screen) hands the keyboard
 * back to the program; a press on a control or the find box keeps it where the press put it.
 * Without this a click on dead space moved focus to the page body and every key after it went nowhere.
 */
export function pressReturnsKeyboard(
	target: { closest(selector: string): unknown } | null,
): boolean {
	return !target || !target.closest(CONTROLS)
}

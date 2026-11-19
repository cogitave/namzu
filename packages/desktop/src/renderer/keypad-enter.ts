/**
 * The Enter key on the number pad presses a focused button, as the main Enter does.
 *
 * Both keys say `Enter`, but a button is pressed by the browser's own handling of the main key,
 * and the number pad's key did not always reach it: a focused Send or Continue ignored it. The
 * keys of this app's own handlers already read both. This one covers the buttons the browser is
 * left to press: at the capture phase the number pad's Enter on a button presses it (and the
 * default is stopped, so a browser that does press it does not press it twice).
 */

interface KeypadEvent {
	code: string
	key: string
	defaultPrevented: boolean
	altKey: boolean
	ctrlKey: boolean
	metaKey: boolean
	shiftKey: boolean
	isComposing?: boolean
	target: unknown
	preventDefault(): void
}

/** Presses the target and returns true when this was the number pad's Enter on an enabled button. */
export function pressButtonWithKeypadEnter(event: KeypadEvent): boolean {
	if (event.code !== 'NumpadEnter' || event.key !== 'Enter' || event.defaultPrevented) return false
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing)
		return false
	const target = event.target as { tagName?: string; disabled?: boolean; click?: () => void } | null
	if (!target || target.tagName !== 'BUTTON' || target.disabled || !target.click) return false
	event.preventDefault()
	target.click()
	return true
}

/** Installs the handler on the document; returns the undo. */
export function installKeypadEnter(
	doc: Pick<Document, 'addEventListener' | 'removeEventListener'>,
) {
	const onKeyDown = (event: Event) => {
		pressButtonWithKeypadEnter(event as unknown as KeypadEvent)
	}
	doc.addEventListener('keydown', onKeyDown, true)
	return () => doc.removeEventListener('keydown', onKeyDown, true)
}

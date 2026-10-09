/**
 * The chords that move between, reorder and close the tabs of a pane. One table serves the
 * window, the terminal (which hands these chords to the window instead of the program) and the
 * labels the command palette shows.
 */
export type TabChord =
	| { kind: 'close' }
	| { kind: 'next' }
	| { kind: 'previous' }
	/** One-based tab number; the ninth chord always means the last tab. */
	| { kind: 'select'; number: number }
	| { kind: 'move'; delta: -1 | 1 }
	| { kind: 'split-right' }

export interface TabKeyEvent {
	key: string
	code: string
	ctrlKey: boolean
	metaKey: boolean
	shiftKey: boolean
	altKey: boolean
}

/**
 * What a key press means for the tab strip, if anything. Ctrl+W closes the tab in front even in a
 * terminal, where the program gives up the shell's delete-a-word; Ctrl+C, Ctrl+D and every other
 * chord stay the program's.
 */
export function tabChord(event: TabKeyEvent, options: { mac: boolean }): TabChord | undefined {
	if (event.altKey) return undefined
	const { ctrlKey, metaKey, shiftKey, code } = event
	// Ctrl+Tab and Ctrl+PageUp/PageDown are Control on every platform, as in a browser.
	if (ctrlKey && !metaKey) {
		if (code === 'Tab') return { kind: shiftKey ? 'previous' : 'next' }
		if (code === 'PageDown') return shiftKey ? { kind: 'move', delta: 1 } : { kind: 'next' }
		if (code === 'PageUp') return shiftKey ? { kind: 'move', delta: -1 } : { kind: 'previous' }
		if (code === 'F4' && !shiftKey) return { kind: 'close' }
	}
	const primary = options.mac ? metaKey && !ctrlKey : ctrlKey && !metaKey
	if (!primary) return undefined
	if (!shiftKey) {
		const digit = /^Digit([1-9])$/.exec(code)
		if (digit) return { kind: 'select', number: Number(digit[1]) }
		if (code === 'KeyW') return { kind: 'close' }
	} else if (code === 'Backslash') return { kind: 'split-right' }
	return undefined
}

/** The tab number a chord of `select` picks among `count` tabs; the ninth is the last. */
export function selectedTabIndex(number: number, count: number): number | undefined {
	if (count === 0) return undefined
	const index = number >= 9 ? count - 1 : number - 1
	return index < count ? index : undefined
}

/** `delta` places along the strip, or `undefined` when the tab is already at that end. */
export function movedTabIndex(index: number, delta: -1 | 1, count: number): number | undefined {
	const next = index + delta
	return next >= 0 && next < count ? next : undefined
}

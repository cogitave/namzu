import type { PalComputerInput, PalScreenView } from '../shared/protocol.js'

/** A decoded frame remains usable while the same allocation refreshes at the same geometry. */
export function computerFrameReady(
	loaded: Pick<PalScreenView, 'width' | 'height'> | null,
	current: Pick<PalScreenView, 'width' | 'height'> | null,
): boolean {
	return (
		!!loaded &&
		!!current &&
		Number.isSafeInteger(loaded.width) &&
		Number.isSafeInteger(loaded.height) &&
		loaded.width > 0 &&
		loaded.height > 0 &&
		loaded.width === current.width &&
		loaded.height === current.height
	)
}

/** Map only the rendered pixels, excluding letterboxing from object-fit: contain. */
export function computerScreenPoint(
	client: { x: number; y: number },
	box: { left: number; top: number; width: number; height: number },
	screen: Pick<PalScreenView, 'width' | 'height'>,
): { x: number; y: number } | null {
	if (
		![
			client.x,
			client.y,
			box.left,
			box.top,
			box.width,
			box.height,
			screen.width,
			screen.height,
		].every(Number.isFinite) ||
		box.width <= 0 ||
		box.height <= 0 ||
		screen.width <= 0 ||
		screen.height <= 0
	)
		return null
	const scale = Math.min(box.width / screen.width, box.height / screen.height)
	const left = box.left + (box.width - screen.width * scale) / 2
	const top = box.top + (box.height - screen.height * scale) / 2
	const x = (client.x - left) / scale
	const y = (client.y - top) / scale
	if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return null
	return { x: Math.floor(x), y: Math.floor(y) }
}

const keyNames: Record<string, string> = {
	Enter: 'ENTER',
	Escape: 'ESC',
	Backspace: 'BACKSPACE',
	Delete: 'DELETE',
	ArrowUp: 'ARROWUP',
	ArrowDown: 'ARROWDOWN',
	ArrowLeft: 'ARROWLEFT',
	ArrowRight: 'ARROWRIGHT',
	Home: 'Home',
	End: 'End',
	PageUp: 'PAGEUP',
	PageDown: 'PAGEDOWN',
	Insert: 'Insert',
	' ': 'SPACE',
	'+': 'plus',
	'-': 'minus',
	'=': 'equal',
	'.': 'period',
	',': 'comma',
	'/': 'slash',
	'\\': 'backslash',
	';': 'semicolon',
	"'": 'apostrophe',
	'[': 'bracketleft',
	']': 'bracketright',
	'`': 'grave',
}

/** Text follows the actual keyboard layout. Tab remains available to leave the screen. */
export function computerKeyboardInput(event: {
	key: string
	ctrlKey: boolean
	altKey: boolean
	metaKey: boolean
	shiftKey: boolean
	isComposing?: boolean
	altGraph?: boolean
}): PalComputerInput | null {
	if (event.isComposing || event.key === 'Tab') return null
	const printable = [...event.key].length === 1
	if (printable && (event.altGraph || (!event.ctrlKey && !event.altKey && !event.metaKey)))
		return { type: 'type_text', text: event.key }
	// Uppercase X keysyms can imply Shift; preserve Shift only through the explicit modifier.
	const key =
		keyNames[event.key] ??
		(/^F(?:[1-9]|1[0-2])$/.test(event.key)
			? event.key
			: /^[a-zA-Z0-9]$/.test(event.key)
				? event.key.toLowerCase()
				: undefined)
	if (!key) return null
	const modifiers = [
		event.ctrlKey ? 'CTRL' : '',
		event.altKey ? 'ALT' : '',
		event.metaKey ? 'SUPER' : '',
		event.shiftKey ? 'SHIFT' : '',
	].filter(Boolean)
	return { type: 'key', keys: [...modifiers, key].join('+') }
}

/**
 * Keyboard shortcuts as the settings store them: Electron's accelerator text, modifiers first in
 * one fixed order, then one key (`Ctrl+Alt+Space`). An empty string is "no shortcut".
 */

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Super'] as const
type Modifier = (typeof MODIFIERS)[number]

const NAMED_KEYS = [
	'Space',
	'Tab',
	'Up',
	'Down',
	'Left',
	'Right',
	'Home',
	'End',
	'PageUp',
	'PageDown',
	'Insert',
	'Delete',
] as const

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/

function isKey(key: string): boolean {
	return (
		/^[A-Z0-9]$/.test(key) ||
		FUNCTION_KEY.test(key) ||
		(NAMED_KEYS as readonly string[]).includes(key)
	)
}

/**
 * Whether `value` is a shortcut a person can press and Namzu may register globally: one key and
 * at least one of Ctrl, Alt or Super (Shift alone would swallow ordinary typing).
 */
export function isAccelerator(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 40) return false
	const parts = value.split('+')
	const key = parts.pop() as string
	if (!isKey(key)) return false
	const seen = new Set<string>()
	for (const part of parts) {
		if (!(MODIFIERS as readonly string[]).includes(part) || seen.has(part)) return false
		seen.add(part)
	}
	return seen.has('Ctrl') || seen.has('Alt') || seen.has('Super')
}

/** What the shortcut setting may hold: nothing, or a valid shortcut. */
export function isShortcutSetting(value: unknown): value is string {
	return value === '' || isAccelerator(value)
}

export interface PressedKey {
	/** `KeyboardEvent.code`: the physical key, so a keyboard layout never changes the answer. */
	code: string
	ctrlKey: boolean
	altKey: boolean
	shiftKey: boolean
	metaKey: boolean
}

const CODE_NAMES: Readonly<Record<string, string>> = {
	Space: 'Space',
	Tab: 'Tab',
	ArrowUp: 'Up',
	ArrowDown: 'Down',
	ArrowLeft: 'Left',
	ArrowRight: 'Right',
	Home: 'Home',
	End: 'End',
	PageUp: 'PageUp',
	PageDown: 'PageDown',
	Insert: 'Insert',
	Delete: 'Delete',
}

function keyName(code: string): string | undefined {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3)
	if (/^Digit[0-9]$/.test(code)) return code.slice(5)
	if (FUNCTION_KEY.test(code)) return code
	return CODE_NAMES[code]
}

/** The shortcut a key press spells, or `undefined` while it is only modifiers or not a usable shortcut. */
export function acceleratorFromPress(press: PressedKey): string | undefined {
	const key = keyName(press.code)
	if (!key) return undefined
	const held: Modifier[] = []
	if (press.ctrlKey) held.push('Ctrl')
	if (press.altKey) held.push('Alt')
	if (press.shiftKey) held.push('Shift')
	if (press.metaKey) held.push('Super')
	const value = [...held, key].join('+')
	return isAccelerator(value) ? value : undefined
}

/** The Dictation shortcut's choices; the stored value is the id. */
export const DICTATION_CHOICES = [
	{ value: 'ctrl-d', label: 'Ctrl+D' },
	{ value: 'ctrl-shift-d', label: 'Ctrl+Shift+D' },
	{ value: 'off', label: 'Off' },
] as const

/** Whether this key press is the chosen dictation shortcut. */
export function dictationPressed(
	choice: string,
	press: PressedKey & { repeat?: boolean },
): boolean {
	if (press.repeat || press.code !== 'KeyD' || !press.ctrlKey || press.altKey || press.metaKey)
		return false
	if (choice === 'ctrl-d') return !press.shiftKey
	if (choice === 'ctrl-shift-d') return press.shiftKey
	return false
}

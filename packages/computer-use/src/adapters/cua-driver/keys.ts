/**
 * Our key input (`ctrl+c`, `ENTER`, `alt+F4`, `/`) → the cua-driver call that
 * presses it.
 *
 * cua-driver's key vocabulary is `return`, `tab`, `escape`, `backspace`,
 * `delete`, `insert`, arrows, `space`, `home`, `end`, `pageup`, `pagedown`,
 * `f1`–`f12`, letters and digits, with modifiers `ctrl`, `shift`, `alt` and
 * `win`. A single printable character pressed on its own is sent as text
 * instead: cua-driver resolves a punctuation key to a virtual key without its
 * shift state, so on a Turkish layout `/` (Shift+7) arrived as `7`. Text goes
 * through the layout-independent Unicode path and arrives as written.
 */

export type CuaKeyPlan =
	| { readonly tool: 'press_key'; readonly key: string }
	| { readonly tool: 'hotkey'; readonly keys: readonly string[] }
	| { readonly tool: 'type_text'; readonly text: string }

const MODIFIERS: Readonly<Record<string, string>> = {
	ctrl: 'ctrl',
	control: 'ctrl',
	// A model trained on macOS shortcuts asks for cmd+c; on Windows that is ctrl+c.
	cmd: 'ctrl',
	command: 'ctrl',
	meta: 'ctrl',
	alt: 'alt',
	option: 'alt',
	opt: 'alt',
	shift: 'shift',
	win: 'win',
	windows: 'win',
	super: 'win',
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
	enter: 'return',
	return: 'return',
	esc: 'escape',
	escape: 'escape',
	tab: 'tab',
	backspace: 'backspace',
	back_space: 'backspace',
	delete: 'delete',
	del: 'delete',
	forward_delete: 'delete',
	insert: 'insert',
	ins: 'insert',
	space: 'space',
	spacebar: 'space',
	up: 'up',
	down: 'down',
	left: 'left',
	right: 'right',
	arrowup: 'up',
	arrowdown: 'down',
	arrowleft: 'left',
	arrowright: 'right',
	arrow_up: 'up',
	arrow_down: 'down',
	arrow_left: 'left',
	arrow_right: 'right',
	home: 'home',
	end: 'end',
	page_up: 'pageup',
	pageup: 'pageup',
	pgup: 'pageup',
	page_down: 'pagedown',
	pagedown: 'pagedown',
	pgdn: 'pagedown',
	plus: '+',
	minus: '-',
}

/** Splits `ctrl++` and `+` correctly: a `+` is a key when it has nothing after it. */
function splitCombo(combo: string): string[] {
	const trimmed = combo.trim()
	if (trimmed === '+') return ['+']
	const parts = trimmed.split('+').map((part) => part.trim())
	if (trimmed.endsWith('++')) {
		// "ctrl++" splits to ["ctrl", "", ""]: the last key is "+".
		return [...parts.slice(0, -2).filter((part) => part.length > 0), '+']
	}
	return parts.filter((part) => part.length > 0)
}

export function translateKeyForCuaDriver(combo: string): CuaKeyPlan {
	const parts = splitCombo(combo)
	if (parts.length === 0) throw new Error('computer-use: empty key combo')
	const main = parts[parts.length - 1] as string
	const modifiers = parts.slice(0, -1).map((part) => {
		const modifier = MODIFIERS[part.toLowerCase()]
		if (!modifier) throw new Error(`computer-use: unknown modifier "${part}" in "${combo}"`)
		return modifier
	})
	const lower = main.toLowerCase()
	const mainAsModifier = MODIFIERS[lower]
	const named = NAMED_KEYS[lower]
	const key =
		named ?? mainAsModifier ?? (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower) ? lower : undefined)

	if (modifiers.length === 0) {
		if (key !== undefined && key.length > 1) return { tool: 'press_key', key }
		// One printable character, pressed alone: send it as text so the layout
		// cannot change it (and an uppercase letter stays uppercase).
		const character = key ?? main
		if ([...character].length === 1) return { tool: 'type_text', text: character }
		return { tool: 'press_key', key: lower }
	}
	const finalKey = key ?? ([...main].length === 1 ? main.toLowerCase() : lower)
	return { tool: 'hotkey', keys: [...new Set(modifiers), finalKey] }
}

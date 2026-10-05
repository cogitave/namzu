import type { PalComputerInput } from '../shared/protocol.js'
import { computerKeyboardInput } from './pal-computer-input.js'

interface KeyboardEventInput {
	readonly key: string
	readonly code?: string
	readonly ctrlKey: boolean
	readonly altKey: boolean
	readonly metaKey: boolean
	readonly shiftKey: boolean
	readonly isComposing?: boolean
	readonly altGraph?: boolean
}

const keyNames: Record<string, string> = {
	Enter: 'Return',
	Escape: 'Escape',
	Backspace: 'BackSpace',
	Delete: 'Delete',
	ArrowUp: 'Up',
	ArrowDown: 'Down',
	ArrowLeft: 'Left',
	ArrowRight: 'Right',
	Home: 'Home',
	End: 'End',
	PageUp: 'Prior',
	PageDown: 'Next',
	Insert: 'Insert',
	' ': 'space',
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
	'!': 'exclam',
	'@': 'at',
	'#': 'numbersign',
	$: 'dollar',
	'%': 'percent',
	'^': 'asciicircum',
	'&': 'ampersand',
	'*': 'asterisk',
	'(': 'parenleft',
	')': 'parenright',
	_: 'underscore',
	':': 'colon',
	'"': 'quotedbl',
	'<': 'less',
	'>': 'greater',
	'?': 'question',
	'|': 'bar',
	'{': 'braceleft',
	'}': 'braceright',
	'~': 'asciitilde',
}
const modifiers = [
	['ctrlKey', 'Control_L'],
	['altKey', 'Alt_L'],
	['metaKey', 'Super_L'],
	['shiftKey', 'Shift_L'],
] as const
const modifierEvents = new Set(['Control', 'Alt', 'Meta', 'Shift'])
// xdotool generates implicit modifier events for shifted punctuation keysyms.
// Complete text/shortcut input restores active modifiers; held input must not claim those keys.
const shiftedPunctuation = new Set('+!@#$%^&*()_:"<>?|{}~')

/** One focus lifetime. Releases name only this lifetime, never all guest keys. */
export class ComputerHeldKeyboard {
	private keyboardId: string | undefined
	private readonly held = new Map<string, string>()
	private readonly heldModifiers = new Set<string>()

	constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

	down(event: KeyboardEventInput): PalComputerInput[] | null {
		if (event.isComposing || event.key === 'Tab' || event.key === 'Dead' || event.key === 'Process')
			return null
		if (shiftedPunctuation.has(event.key)) {
			const input = computerKeyboardInput(event)
			return input ? [input] : null
		}
		// Preserve actual non-ASCII/AltGraph text with the existing text port.
		const printable = [...event.key].length === 1
		if (event.altGraph) return printable ? [{ type: 'type_text', text: event.key }] : null
		if (printable && !/^[\x20-\x7e]$/.test(event.key))
			return !event.ctrlKey && !event.altKey && !event.metaKey
				? [{ type: 'type_text', text: event.key }]
				: null
		const key =
			keyNames[event.key] ??
			(/^[a-zA-Z0-9]$/.test(event.key)
				? event.key.toLowerCase()
				: /^F(?:[1-9]|1[0-2])$/.test(event.key)
					? event.key
					: undefined)
		if (!key && !modifierEvents.has(event.key)) return null
		const actions = this.syncModifiers(event)
		if (!key) return actions
		const physical = event.code || event.key
		if (this.held.has(physical)) return actions
		const alreadyHeld = [...this.held.values()].includes(key)
		this.held.set(physical, key)
		if (!alreadyHeld) actions.push(this.action('key_down', key))
		return actions
	}

	up(event: KeyboardEventInput): PalComputerInput[] | null {
		const physical = event.code || event.key
		const key = this.held.get(physical)
		if (!key && !modifierEvents.has(event.key)) return null
		const actions: PalComputerInput[] = []
		if (key) {
			this.held.delete(physical)
			if (![...this.held.values()].includes(key)) actions.push(this.action('key_up', key))
		}
		actions.push(...this.syncModifiers(event))
		return actions
	}

	/** Also cleans up a completed lifetime so a later focus cannot reuse its identity. */
	release(): Extract<PalComputerInput, { type: 'release_keys' }> | null {
		const keyboardId = this.keyboardId
		this.keyboardId = undefined
		this.held.clear()
		this.heldModifiers.clear()
		return keyboardId ? { type: 'release_keys', keyboardId } : null
	}

	private action(type: 'key_down' | 'key_up', key: string): PalComputerInput {
		this.keyboardId ??= this.createId()
		return { type, key, keyboardId: this.keyboardId }
	}

	private syncModifiers(event: KeyboardEventInput): PalComputerInput[] {
		const actions: PalComputerInput[] = []
		for (const [property, key] of modifiers) {
			if (event[property] && !this.heldModifiers.has(key)) {
				this.heldModifiers.add(key)
				actions.push(this.action('key_down', key))
			} else if (!event[property] && this.heldModifiers.delete(key))
				actions.push(this.action('key_up', key))
		}
		return actions
	}
}

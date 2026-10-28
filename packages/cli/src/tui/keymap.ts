/**
 * The terminal UI's action registry.
 *
 * Every shortcut the chat screen answers is one entry here: an action id, the
 * keys that run it, and the words `/help keys` shows for it. The key handlers
 * in the composer and the app ask the registry whether a keypress is a given
 * action (`isAction`, `isChordAction`) instead of testing modifiers inline, so
 * a key lives in one place and the help text cannot drift from what the keys
 * do.
 *
 * A key is written `ctrl+s`, `meta+p` (Alt), `shift+tab`, `escape`, `return`,
 * `up`. Two strokes separated by a space are a chord: `ctrl+x ctrl+s` is
 * Ctrl+X followed by Ctrl+S. A chord's first stroke is its lead; the handler
 * that owns the lead remembers it (see `isChordLead`) and asks for the second
 * stroke on the next keypress.
 *
 * Matching is as loose as the inline tests it replaced: a declared modifier
 * must be held, an undeclared one is not checked. The order the handlers ask
 * in is what keeps `shift+return` ahead of `return`.
 */

/** The parts of an Ink key event the registry reads. */
export interface KeyEvent {
	readonly ctrl?: boolean
	readonly meta?: boolean
	readonly shift?: boolean
	readonly escape?: boolean
	readonly return?: boolean
	readonly tab?: boolean
	readonly backspace?: boolean
	readonly delete?: boolean
	readonly upArrow?: boolean
	readonly downArrow?: boolean
	readonly leftArrow?: boolean
	readonly rightArrow?: boolean
	readonly pageUp?: boolean
	readonly pageDown?: boolean
	readonly home?: boolean
	readonly end?: boolean
}

/** `Task` keys act on a running command and give way to the chat key they share when none runs. */
export type KeyContext = 'Global' | 'Chat' | 'HistorySearch' | 'Task'

export type KeyGroup = 'Conversation' | 'Models and modes' | 'Editing' | 'Agents and jobs'

export interface ActionSpec {
	readonly id: string
	readonly context: KeyContext
	readonly group: KeyGroup
	/** Keys that run the action; the first one is the one `/help keys` names. */
	readonly keys: readonly string[]
	/** What it does, in plain words for `/help keys`. Empty keeps it off the list. */
	readonly help: string
}

const action = <const Id extends string>(spec: ActionSpec & { readonly id: Id }) => spec

export const ACTIONS = [
	action({
		id: 'app:interrupt',
		context: 'Global',
		group: 'Conversation',
		keys: ['ctrl+c'],
		help: 'Stop the reply; press twice to exit',
	}),
	action({
		id: 'app:exit',
		context: 'Global',
		group: 'Conversation',
		keys: ['ctrl+d'],
		help: 'Exit, on an empty message (press twice)',
	}),
	action({
		id: 'app:toggleTranscript',
		context: 'Global',
		group: 'Conversation',
		keys: ['ctrl+o'],
		help: 'Open the detailed transcript',
	}),
	action({
		id: 'app:openAgents',
		context: 'Global',
		group: 'Agents and jobs',
		keys: ['ctrl+t'],
		help: 'Open or close delegated work',
	}),
	action({
		id: 'history:search',
		context: 'Global',
		group: 'Conversation',
		keys: ['ctrl+r'],
		help: 'Search earlier messages',
	}),
	action({
		id: 'historySearch:newer',
		context: 'HistorySearch',
		group: 'Conversation',
		keys: ['ctrl+s'],
		help: 'While searching, go to a newer match',
	}),
	action({
		id: 'chat:cancel',
		context: 'Chat',
		group: 'Conversation',
		keys: ['escape'],
		help: 'Interrupt a reply; twice clears a draft, or on an empty message opens rewind',
	}),
	action({
		id: 'chat:clearScreen',
		context: 'Chat',
		group: 'Conversation',
		keys: ['ctrl+l'],
		help: 'Clear the screen (the conversation is kept)',
	}),
	action({
		id: 'chat:submit',
		context: 'Chat',
		group: 'Conversation',
		keys: ['return'],
		help: 'Send the message, or steer the reply in progress',
	}),
	action({
		id: 'chat:queue',
		context: 'Chat',
		group: 'Conversation',
		keys: ['tab'],
		help: 'Queue the message for after the reply',
	}),
	action({
		id: 'chat:newline',
		context: 'Chat',
		group: 'Editing',
		keys: ['shift+return', 'meta+return', 'ctrl+j'],
		help: 'New line',
	}),
	action({
		id: 'chat:sendNow',
		context: 'Chat',
		group: 'Conversation',
		keys: ['ctrl+x ctrl+s'],
		help: 'Send queued messages now',
	}),
	action({
		id: 'chat:recallQueued',
		context: 'Chat',
		group: 'Conversation',
		keys: ['meta+up'],
		help: 'Bring the last queued message back for editing',
	}),
	action({
		id: 'chat:stash',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+s'],
		help: 'Set the draft aside; press again on an empty message to bring it back',
	}),
	action({
		id: 'chat:undo',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+_', 'ctrl+-'],
		help: 'Undo the last edit to the draft',
	}),
	action({
		id: 'chat:externalEditor',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+g', 'ctrl+x ctrl+e'],
		help: 'Edit the draft in your editor',
	}),
	action({
		id: 'chat:imagePaste',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+v', 'meta+v'],
		help: 'Paste an image from the clipboard',
	}),
	action({
		id: 'chat:triggerToggle',
		context: 'Chat',
		group: 'Editing',
		keys: ['meta+w'],
		help: 'Drop or restore the keyword nearest the cursor',
	}),
	action({
		id: 'chat:cycleMode',
		context: 'Chat',
		group: 'Models and modes',
		keys: ['shift+tab'],
		help: 'Change the permission mode',
	}),
	action({
		id: 'chat:modelPicker',
		context: 'Chat',
		group: 'Models and modes',
		keys: ['meta+p'],
		help: 'Choose a model',
	}),
	action({
		id: 'chat:thinkingToggle',
		context: 'Chat',
		group: 'Models and modes',
		keys: ['meta+t'],
		help: 'Switch thinking on or off',
	}),
	action({
		id: 'chat:effortLower',
		context: 'Chat',
		group: 'Models and modes',
		keys: ['shift+down', 'meta+,'],
		help: 'Think less',
	}),
	action({
		id: 'chat:effortRaise',
		context: 'Chat',
		group: 'Models and modes',
		keys: ['shift+up', 'meta+.'],
		help: 'Think more',
	}),
	action({
		id: 'task:background',
		context: 'Task',
		group: 'Agents and jobs',
		keys: ['ctrl+b'],
		help: 'Move a running shell command to the background',
	}),
	action({
		id: 'chat:killAgents',
		context: 'Chat',
		group: 'Agents and jobs',
		keys: ['ctrl+x ctrl+k'],
		help: 'Stop all background agents',
	}),
	action({
		id: 'edit:lineStart',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+a', 'home'],
		help: 'Start of the line',
	}),
	action({
		id: 'edit:lineEnd',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+e', 'end'],
		help: 'End of the line',
	}),
	action({
		id: 'edit:charLeft',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+b', 'left'],
		help: 'Back one character',
	}),
	action({
		id: 'edit:charRight',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+f', 'right'],
		help: 'Forward one character',
	}),
	action({
		id: 'edit:wordLeft',
		context: 'Chat',
		group: 'Editing',
		keys: ['meta+b', 'ctrl+left', 'meta+left'],
		help: 'Back one word',
	}),
	action({
		id: 'edit:wordRight',
		context: 'Chat',
		group: 'Editing',
		keys: ['meta+f', 'ctrl+right', 'meta+right'],
		help: 'Forward one word',
	}),
	action({
		id: 'edit:linePrevious',
		context: 'Chat',
		group: 'Editing',
		keys: ['up', 'ctrl+p'],
		help: 'Up a line, then through earlier messages',
	}),
	action({
		id: 'edit:lineNext',
		context: 'Chat',
		group: 'Editing',
		keys: ['down', 'ctrl+n'],
		help: 'Down a line, then back to the draft',
	}),
	action({
		id: 'edit:deleteForward',
		context: 'Chat',
		group: 'Editing',
		keys: ['delete', 'ctrl+d'],
		help: 'Delete the character after the cursor',
	}),
	action({
		id: 'edit:deleteWordBack',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+w', 'meta+backspace', 'ctrl+backspace'],
		help: 'Delete the word before the cursor',
	}),
	action({
		id: 'edit:deleteWordForward',
		context: 'Chat',
		group: 'Editing',
		keys: ['meta+d'],
		help: 'Delete the word after the cursor',
	}),
	action({
		id: 'edit:deleteToLineStart',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+u'],
		help: 'Delete to the start of the line',
	}),
	action({
		id: 'edit:deleteToLineEnd',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+k'],
		help: 'Delete to the end of the line',
	}),
	action({
		id: 'edit:yank',
		context: 'Chat',
		group: 'Editing',
		keys: ['ctrl+y'],
		help: 'Paste what was last deleted',
	}),
] as const

export type ActionId = (typeof ACTIONS)[number]['id']

const BY_ID: ReadonlyMap<string, ActionSpec> = new Map(ACTIONS.map((spec) => [spec.id, spec]))

/** The registry's entry for an action. */
export function actionSpec(id: ActionId): ActionSpec {
	const spec = BY_ID.get(id)
	if (!spec) throw new Error(`Unknown action ${id}`)
	return spec
}

interface Stroke {
	readonly ctrl: boolean
	readonly meta: boolean
	readonly shift: boolean
	readonly base: string
}

const STROKES = new Map<string, Stroke>()

function parseStroke(text: string): Stroke {
	const cached = STROKES.get(text)
	if (cached) return cached
	const parts = text.split('+')
	// `ctrl++` is not a key anyone binds, but a trailing `+` base must survive.
	const base = text.endsWith('+') ? '+' : (parts.pop() ?? '')
	const mods = new Set(parts)
	const stroke: Stroke = {
		ctrl: mods.has('ctrl'),
		meta: mods.has('meta') || mods.has('alt'),
		shift: mods.has('shift'),
		base,
	}
	STROKES.set(text, stroke)
	return stroke
}

const NAMED: Readonly<Record<string, keyof KeyEvent>> = {
	escape: 'escape',
	return: 'return',
	tab: 'tab',
	backspace: 'backspace',
	delete: 'delete',
	up: 'upArrow',
	down: 'downArrow',
	left: 'leftArrow',
	right: 'rightArrow',
	pageup: 'pageUp',
	pagedown: 'pageDown',
	home: 'home',
	end: 'end',
}

/** What a terminal sends for Ctrl+_ (and Ctrl+/ and Ctrl+7): Ink gives it as plain input. */
const UNIT_SEPARATOR = '\x1f'

function matchStroke(text: string, input: string, key: KeyEvent): boolean {
	const stroke = parseStroke(text)
	if (stroke.ctrl && !key.ctrl && !(stroke.base === '_' && input === UNIT_SEPARATOR)) return false
	if (stroke.meta && !key.meta) return false
	if (stroke.shift && !key.shift) return false
	const named = NAMED[stroke.base]
	if (named !== undefined) return key[named] === true
	if (stroke.base === '_' && stroke.ctrl && input === UNIT_SEPARATOR) return true
	// A modified letter is the letter itself in `input`; an unmodified one
	// would be typing, which no action binds.
	if (!stroke.ctrl && !stroke.meta) return false
	return input === stroke.base
}

function strokesOf(chord: string): readonly string[] {
	return chord.split(' ')
}

/** Whether a keypress runs a single-stroke action. */
export function isAction(id: ActionId, input: string, key: KeyEvent): boolean {
	for (const chord of actionSpec(id).keys) {
		const strokes = strokesOf(chord)
		if (strokes.length === 1 && matchStroke(chord, input, key)) return true
	}
	return false
}

/** Whether a keypress is the first stroke of any two-stroke action (`ctrl+x`). */
export function isChordLead(input: string, key: KeyEvent): boolean {
	for (const spec of ACTIONS) {
		for (const chord of spec.keys) {
			const strokes = strokesOf(chord)
			const lead = strokes[0]
			if (strokes.length === 2 && lead !== undefined && matchStroke(lead, input, key)) return true
		}
	}
	return false
}

/** Whether a keypress is the second stroke of a chord action, the lead having just been pressed. */
export function isChordAction(id: ActionId, input: string, key: KeyEvent): boolean {
	for (const chord of actionSpec(id).keys) {
		const strokes = strokesOf(chord)
		const second = strokes[1]
		if (strokes.length === 2 && second !== undefined && matchStroke(second, input, key)) return true
	}
	return false
}

/**
 * The key of an action that a keypress just matched, as a person reads it
 * (`Ctrl+G`, `Ctrl+X Ctrl+E`). `afterLead` asks about a chord's second stroke,
 * the lead having just been pressed. Empty when the press is not the action.
 */
export function pressedKeyLabel(
	id: ActionId,
	input: string,
	key: KeyEvent,
	afterLead = false,
): string {
	for (const chord of actionSpec(id).keys) {
		const strokes = strokesOf(chord)
		const stroke = afterLead ? strokes[1] : strokes[0]
		if (afterLead ? strokes.length !== 2 : strokes.length !== 1) continue
		if (stroke !== undefined && matchStroke(stroke, input, key)) return keyLabel(chord)
	}
	return ''
}

const NAME_LABELS: Readonly<Record<string, string>> = {
	meta: 'Alt',
	ctrl: 'Ctrl',
	shift: 'Shift',
	escape: 'Esc',
	return: 'Enter',
	tab: 'Tab',
	up: 'Up',
	down: 'Down',
	left: 'Left',
	right: 'Right',
	backspace: 'Backspace',
	delete: 'Delete',
	home: 'Home',
	end: 'End',
	pageup: 'Page Up',
	pagedown: 'Page Down',
}

function labelStroke(stroke: string): string {
	if (stroke.endsWith('+')) return stroke.slice(0, -1).split('+').map(labelPart).join('+') + '++'
	return stroke.split('+').map(labelPart).join('+')
}

function labelPart(part: string): string {
	return NAME_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part)
}

/** A key as a person reads it: `Ctrl+X Ctrl+S`, `Alt+P`, `Shift+Tab`. */
export function keyLabel(chord: string): string {
	return strokesOf(chord).map(labelStroke).join(' ')
}

/** The key `/help keys` and hints name for an action. */
export function primaryKeyLabel(id: ActionId): string {
	const first = actionSpec(id).keys[0]
	return first === undefined ? '' : keyLabel(first)
}

const GROUP_ORDER: readonly KeyGroup[] = [
	'Conversation',
	'Models and modes',
	'Editing',
	'Agents and jobs',
]

/** The shortcut list `/help keys` prints, grouped, one key and its meaning per row. */
export function keysHelpText(): string {
	const lines: string[] = ['Keyboard shortcuts']
	for (const group of GROUP_ORDER) {
		const rows = ACTIONS.filter((spec) => spec.group === group && spec.help !== '')
		if (rows.length === 0) continue
		const labels = rows.map((spec) => spec.keys.map(keyLabel).join(' or '))
		const width = Math.max(...labels.map((label) => label.length))
		lines.push('', group)
		rows.forEach((spec, index) => {
			lines.push(`  ${(labels[index] ?? '').padEnd(width)}  ${spec.help}`)
		})
	}
	return lines.join('\n')
}

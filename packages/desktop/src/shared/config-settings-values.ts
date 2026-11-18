/**
 * How the list and map controls turn what is ticked, typed or chosen into the value saved, and a
 * saved value back into words. The terminal's `namzu config` uses the same rules from
 * `cli/src/config/setting-values.ts`; Desktop cannot import the CLI, so a test feeds one table of
 * inputs to both and fails when they stop agreeing.
 */

import type { ConfigSettingControl, ConfigSettingOption } from './config-settings-protocol.js'

/** Two lists hold the same words, whatever the order. Anything that is not a list of words is not. */
export function sameSet(a: unknown, b: unknown): boolean {
	if (!Array.isArray(a) || !Array.isArray(b)) return false
	if (a.some((item) => typeof item !== 'string') || b.some((item) => typeof item !== 'string'))
		return false
	const left = new Set(a as string[])
	const right = new Set(b as string[])
	return left.size === right.size && [...left].every((item) => right.has(item))
}

/** The screen names in a `screens` value: each entry is a name or `{ name, ... }`. */
export function screenNames(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	return value.flatMap((entry) => {
		if (typeof entry === 'string') return [entry]
		const name = (entry as { name?: unknown } | null)?.name
		return typeof name === 'string' ? [name] : []
	})
}

/** The tools a `screens` value lets through, for the screen that takes them. */
export function screenTools(value: unknown, screen: string, field: string): string[] {
	if (!Array.isArray(value)) return []
	const tools: string[] = []
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) continue
		const record = entry as Record<string, unknown>
		if (record.name !== screen || !Array.isArray(record[field])) continue
		for (const tool of record[field] as unknown[]) if (typeof tool === 'string') tools.push(tool)
	}
	return tools
}

/** Whether a new list leaves out an entry the default list holds. */
export function droppedFromDefault(defaults: unknown, value: unknown): boolean {
	const now =
		Array.isArray(value) && value.every((v) => typeof v === 'string')
			? (value as string[])
			: screenNames(value)
	const wanted = Array.isArray(defaults) ? (defaults as string[]) : []
	return wanted.some((name) => !now.includes(name))
}

/** Whether a new list holds an entry the list now in force lacks. */
export function widensList(current: unknown, value: unknown): boolean {
	if (!Array.isArray(value)) return true
	const held = new Set(Array.isArray(current) ? (current as unknown[]) : [])
	return value.some((item) => !held.has(item))
}

/**
 * The value a switch with event checks writes for the ticked events: `false` for none, `true` for
 * exactly the events `true` stands for, otherwise the list in the order the options are drawn.
 */
export function eventSwitchValue(
	ticked: readonly string[],
	control: { options: readonly ConfigSettingOption[]; whenOn: readonly string[] },
): boolean | string[] {
	if (ticked.length === 0) return false
	if (sameSet(ticked, control.whenOn)) return true
	return control.options.map((o) => o.value).filter((value) => ticked.includes(value))
}

/** The events a saved switch value holds ticked: `true` stands for the default pair. */
export function eventSwitchTicked(
	value: unknown,
	control: { whenOn: readonly string[] },
): string[] {
	if (value === true) return [...control.whenOn]
	return Array.isArray(value) ? (value as string[]) : []
}

/**
 * The map a `levels` control saves: every entry left at its default is left out. `undefined` means
 * the map is empty, so the key goes.
 */
export function levelsValue(
	chosen: Readonly<Record<string, string>>,
	defaults: unknown,
): Record<string, string> | undefined {
	const base = (typeof defaults === 'object' && defaults !== null ? defaults : {}) as Record<
		string,
		string
	>
	const out: Record<string, string> = {}
	for (const [id, level] of Object.entries(chosen)) if (base[id] !== level) out[id] = level
	return Object.keys(out).length === 0 ? undefined : out
}

/** The level every entry holds: what is saved, else the default. */
export function levelsHeld(saved: unknown, defaults: unknown): Record<string, string> {
	const base = (typeof defaults === 'object' && defaults !== null ? defaults : {}) as Record<
		string,
		string
	>
	const own = (
		typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? saved : {}
	) as Record<string, string>
	return { ...base, ...own }
}

/**
 * The list a `screens` control saves for the screens ticked and the tools let through: a screen
 * that takes tools is written as `{ name, <field>: [...] }` only when it has some. The default
 * alone is not written, so an unset key stays unset. `undefined` means clear.
 */
export function screensValue(
	ticked: readonly string[],
	tools: readonly string[],
	control: {
		options: readonly ConfigSettingOption[]
		passthrough: { screen: string; field: string }
	},
	defaults: unknown,
): unknown[] | undefined {
	const names = control.options.map((o) => o.value).filter((value) => ticked.includes(value))
	const kept = [...new Set(tools.map((tool) => tool.trim()).filter((tool) => tool !== ''))]
	const list = names.map((name) =>
		name === control.passthrough.screen && kept.length > 0
			? { name, [control.passthrough.field]: kept }
			: name,
	)
	if (kept.length === 0 && sameSet(names, defaults)) return undefined
	return list
}

function labelOf(options: readonly ConfigSettingOption[], value: string): string {
	return options.find((o) => o.value === value)?.label ?? value
}

/**
 * A value of one of the list and map controls in words, or `undefined` for a control this does not
 * word. A list that holds every option says its `allLabel`; one with nothing ticked says why that
 * matters when the control has a note.
 */
export function listControlWords(
	control: ConfigSettingControl,
	value: unknown,
): string | undefined {
	switch (control.kind) {
		case 'checks': {
			if (!Array.isArray(value)) return undefined
			if (control.allLabel && control.options.every((o) => value.includes(o.value)))
				return control.allLabel
			if (value.length === 0) return control.emptyNote ? `none. ${control.emptyNote}` : 'none'
			return undefined
		}
		case 'toggle-checks': {
			const ticked = eventSwitchTicked(value, control)
			if (typeof value === 'boolean' && !value) return 'off'
			if (ticked.length === 0) return 'off'
			return `on: ${ticked.map((item) => labelOf(control.options, item)).join(', ')}`
		}
		case 'toggle-list':
			return sameSet(value, control.on) ? 'on' : sameSet(value, control.off) ? 'off' : undefined
		case 'key':
			return typeof value === 'string' ? labelOf(control.options, value) : undefined
		case 'levels': {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
			return control.entries
				.map((entry) => {
					const level = (value as Record<string, string>)[entry.value]
					return level === undefined
						? undefined
						: `${entry.label} ${labelOf(control.levels, level)}`
				})
				.filter((text): text is string => text !== undefined)
				.join(', ')
		}
		case 'screens': {
			const names = screenNames(value)
			if (!Array.isArray(value)) return undefined
			if (names.length === 0) return 'none. Tool results are not screened.'
			const tools = screenTools(value, control.passthrough.screen, control.passthrough.field)
			const text = names.map((name) => labelOf(control.options, name)).join(', ')
			return tools.length > 0 ? `${text}; lets through ${tools.join(', ')}` : text
		}
		case 'list':
			return Array.isArray(value) ? (value.length === 0 ? 'none' : value.join(', ')) : undefined
		default:
			return undefined
	}
}

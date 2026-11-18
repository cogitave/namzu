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

/** A folder as compared: without a trailing separator, which names the same folder. */
export function folderKey(path: string): string {
	const trimmed = path.trim()
	const bare = trimmed.replace(/[\\/]+$/, '')
	return bare === '' || /^[A-Za-z]:$/.test(bare) ? trimmed : bare
}

/** What a list adds to the one in force, in the order written (a trailing separator is not a new folder). */
export function addedItems(current: unknown, value: unknown): string[] {
	if (!Array.isArray(value)) return []
	const held = new Set(
		(Array.isArray(current) ? (current as unknown[]) : []).map((x) =>
			typeof x === 'string' ? folderKey(x) : x,
		),
	)
	return value.filter(
		(item): item is string => typeof item === 'string' && !held.has(folderKey(item)),
	)
}

/** The sentence asked before a list is widened, naming what is added so a wrong split shows. */
export function widenedConfirmation(sentence: string, current: unknown, value: unknown): string {
	const added = addedItems(current, value)
	return added.length === 0 ? sentence : `${sentence} Added: ${added.join(', ')}.`
}

/** Whether a new list holds an entry the list now in force lacks. */
export function widensList(current: unknown, value: unknown): boolean {
	if (!Array.isArray(value)) return true
	const held = new Set(
		(Array.isArray(current) ? (current as unknown[]) : []).map((x) =>
			typeof x === 'string' ? folderKey(x) : x,
		),
	)
	return value.some((item) => !held.has(typeof item === 'string' ? folderKey(item) : item))
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
		case 'routing':
		case 'auto-mode':
			return modelsControlWords(control, value)
		default:
			return undefined
	}
}

// ---------------------------------------------------------------------------
// Models: the routing table and the auto mode reviewer
// ---------------------------------------------------------------------------

const plain = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

/**
 * A model as written, `provider/model`, split into the two fields the routing table keeps. A name
 * with no slash leaves the provider empty, so the loader refuses it in its own words rather than
 * this guessing a provider. The model keeps any slash of its own (`openrouter/meta/llama`).
 */
export function routingTarget(text: string): { provider: string; model: string } {
	const named = text.trim()
	const slash = named.indexOf('/')
	if (slash < 0) return { provider: '', model: named }
	return { provider: named.slice(0, slash).trim(), model: named.slice(slash + 1).trim() }
}

/** A routing target as one `provider/model` text; empty when the value is not a target. */
export function targetText(target: unknown): string {
	const entry = plain(target)
	if (!entry) return ''
	const provider = typeof entry.provider === 'string' ? entry.provider : ''
	const model = typeof entry.model === 'string' ? entry.model : ''
	return provider === '' ? model : `${provider}/${model}`
}

/** The routing form's fields as text, from the saved table. A field the table lacks is empty. */
export interface RoutingForm {
	readonly default: string
	readonly fast: string
	readonly big: string
	/** `yesno`, `score` or empty for the engine's own choice. */
	readonly strategy: string
	/** Seconds as typed; empty for the engine's default. */
	readonly timeout: string
}

/** Milliseconds as the seconds a person types: 1500 is `1.5`. */
export function timeoutSeconds(ms: number): string {
	return String(ms / 1000)
}

/** Seconds as typed to the milliseconds saved, or the sentence to show. Empty means none. */
export function timeoutFromSeconds(
	text: string,
): { value: number | undefined } | { error: string } {
	const trimmed = text.trim()
	if (trimmed === '') return { value: undefined }
	const wrong = 'Enter seconds from 0.001 to 10, such as 1.5.'
	const seconds = Number(trimmed)
	if (!Number.isFinite(seconds)) return { error: wrong }
	const ms = Math.round(seconds * 1000)
	if (Math.abs(ms - seconds * 1000) > 1e-6 || ms < 1 || ms > 10_000) return { error: wrong }
	return { value: ms }
}

export function routingForm(saved: unknown): RoutingForm {
	const table = plain(saved) ?? {}
	const tiers = plain(table.tiers) ?? {}
	return {
		default: targetText(table.default),
		fast: targetText(tiers.fast),
		big: targetText(tiers.big),
		strategy: typeof table.strategy === 'string' ? table.strategy : '',
		timeout: typeof table.timeoutMs === 'number' ? timeoutSeconds(table.timeoutMs) : '',
	}
}

/**
 * The routing table the form saves. Only what the form shows is written from it; the thresholds
 * the form has no field for stay as they are in `held`. A default left empty is left out, so the
 * loader refuses the table with its own sentence about the default.
 */
export function routingValue(
	form: RoutingForm,
	held?: unknown,
): { value: Record<string, unknown> } | { error: string } {
	const timeout = timeoutFromSeconds(form.timeout)
	if ('error' in timeout) return { error: timeout.error }
	const tiers = {
		...(form.fast.trim() !== '' ? { fast: routingTarget(form.fast) } : {}),
		...(form.big.trim() !== '' ? { big: routingTarget(form.big) } : {}),
	}
	const thresholds = plain(plain(held)?.thresholds)
	return {
		value: {
			...(form.default.trim() !== '' ? { default: routingTarget(form.default) } : {}),
			...(Object.keys(tiers).length > 0 ? { tiers } : {}),
			...(form.strategy !== '' ? { strategy: form.strategy } : {}),
			...(thresholds && Object.keys(thresholds).length > 0 ? { thresholds } : {}),
			...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
		},
	}
}

/** The entry that stands for the built-in rules inside an auto mode list. */
export const DEFAULTS_ENTRY = '$defaults'

/** An auto mode list entry as a person reads it. */
export function autoEntryLabel(entry: string): string {
	return entry === DEFAULTS_ENTRY ? 'Built-in rules' : entry
}

/** The word that names the side model as the reviewer. */
export const SMALL_MODEL_WORD = 'smallModel'

const AUTO_FIELDS = ['model', 'allow', 'softDeny', 'hardDeny', 'environment'] as const

/** The reviewer model saved, or empty when the session's own model reviews. */
export function autoModeModel(saved: unknown): string {
	const model = plain(saved)?.model
	return typeof model === 'string' ? model : ''
}

/** One list as saved, or `undefined` when it is left out (the built-in rules stand). */
export function autoModeList(saved: unknown, field: string): string[] | undefined {
	const list = plain(saved)?.[field]
	return Array.isArray(list) && list.every((item) => typeof item === 'string')
		? (list as string[])
		: undefined
}

/**
 * The table with `patch` applied: a key set to `undefined` is removed, and the table is
 * `undefined` once nothing is left, so the setting is cleared rather than saved empty.
 */
export function autoModeSet(
	held: unknown,
	patch: Readonly<Record<string, string | readonly string[] | undefined>>,
): Record<string, unknown> | undefined {
	const base = { ...(plain(held) ?? {}), ...patch }
	const out: Record<string, unknown> = {}
	for (const key of AUTO_FIELDS) if (base[key] !== undefined) out[key] = base[key]
	return Object.keys(out).length === 0 ? undefined : out
}

/** Lists where an added entry lets more run, and lists where a removed entry does. */
const AUTO_LOOSEN_ON_ADD = ['allow', 'environment'] as const
const AUTO_LOOSEN_ON_REMOVE = ['softDeny', 'hardDeny'] as const

function autoHeld(table: unknown, field: string): string[] {
	return autoModeList(table, field) ?? [DEFAULTS_ENTRY]
}

/**
 * What a change to the reviewer's lists lets through that it did not before: entries added to a
 * list of things allowed or trusted, entries removed from a list of things blocked. A list that is
 * left out counts as `$defaults`, so removing the built-ins from a block list is named too.
 */
export function autoModeLoosened(
	current: unknown,
	value: unknown,
): { field: string; entries: string[] }[] {
	const out: { field: string; entries: string[] }[] = []
	for (const field of AUTO_LOOSEN_ON_ADD) {
		const had = autoHeld(current, field)
		const entries = autoHeld(value, field).filter((item) => !had.includes(item))
		if (entries.length > 0) out.push({ field, entries })
	}
	for (const field of AUTO_LOOSEN_ON_REMOVE) {
		const next = autoHeld(value, field)
		const entries = autoHeld(current, field).filter((item) => !next.includes(item))
		if (entries.length > 0) out.push({ field, entries })
	}
	return out
}

/** Whether a change to the reviewer asks first: another model, or any list let looser. */
export function autoModeAsks(current: unknown, value: unknown): boolean {
	const model = autoModeModel(value)
	if (model !== '' && model !== autoModeModel(current)) return true
	return autoModeLoosened(current, value).length > 0
}

/** The sentence asked first, naming the model and each entry that lets more through. */
export function autoModeConfirmation(
	sentence: string,
	current: unknown,
	value: unknown,
	lists: readonly { value: string; label: string }[],
): string {
	const parts: string[] = []
	const model = autoModeModel(value)
	if (model !== '' && model !== autoModeModel(current)) parts.push(`Reviewer model: ${model}.`)
	for (const { field, entries } of autoModeLoosened(current, value)) {
		const label = lists.find((list) => list.value === field)?.label ?? field
		const verb = (AUTO_LOOSEN_ON_ADD as readonly string[]).includes(field)
			? 'Added to'
			: 'Removed from'
		parts.push(`${verb} "${label}": ${entries.map(autoEntryLabel).join(', ')}.`)
	}
	return parts.length === 0 ? sentence : `${sentence} ${parts.join(' ')}`
}

/** The routing table or the reviewer's settings in words, or `undefined` for anything else. */
function modelsControlWords(
	control: { kind: string; lists?: readonly { value: string; label: string }[] },
	value: unknown,
): string | undefined {
	const table = plain(value)
	if (!table) return undefined
	if (control.kind === 'routing') {
		const form = routingForm(table)
		const parts = [
			form.default !== '' ? `default ${form.default}` : '',
			form.fast !== '' ? `fast ${form.fast}` : '',
			form.big !== '' ? `large ${form.big}` : '',
			form.strategy !== '' ? `strategy ${form.strategy}` : '',
			form.timeout !== '' ? `timeout ${form.timeout}s` : '',
		].filter((part) => part !== '')
		return parts.length > 0 ? parts.join('; ') : undefined
	}
	const parts: string[] = []
	const model = autoModeModel(table)
	if (model !== '') parts.push(`model ${model}`)
	for (const list of control.lists ?? []) {
		const items = autoModeList(table, list.value)
		if (items === undefined) continue
		parts.push(
			`${list.label}: ${items.length === 0 ? 'none' : items.map(autoEntryLabel).join(', ')}`,
		)
	}
	return parts.length > 0 ? parts.join('; ') : 'built-in rules'
}

/** What a row says when an environment variable replaces what is saved. */
export function environmentNote(env: { variable: string; value: string }): string {
	return `${env.variable} is set to ${env.value}, and Namzu uses that instead of what is saved here.`
}

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
		case 'permission-rules':
			return permissionRulesWords(value)
		case 'permission-checks':
			return permissionChecksWords(value)
		case 'sites':
			return sitesWords(control, value)
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

// ---------------------------------------------------------------------------
// Permissions and browser sites: rows, the tables they save, and what lets more run
// ---------------------------------------------------------------------------

/** The keys of `permissions` that are settings with rows of their own, never a tool's rule. */
export const PERMISSION_MODE_KEYS: readonly string[] = [
	'defaultMode',
	'disableBypassMode',
	'disableAutoMode',
	'outsideRoot',
	'autoMode',
]

const EFFECT_WORDS = ['allow', 'ask', 'deny'] as const
const isEffect = (value: unknown): value is (typeof EFFECT_WORDS)[number] =>
	typeof value === 'string' && (EFFECT_WORDS as readonly string[]).includes(value)

/** One rule: a tool, a pattern of its input (empty for every call) and what happens. */
export interface PermissionRuleRow {
	readonly tool: string
	readonly pattern: string
	readonly effect: string
}

/** The rule rows of a rule table, in the order written. An entry that is not a rule is left out. */
export function permissionRuleRows(table: unknown): PermissionRuleRow[] {
	const held = plain(table)
	if (!held) return []
	const rows: PermissionRuleRow[] = []
	for (const [tool, entry] of Object.entries(held)) {
		if (PERMISSION_MODE_KEYS.includes(tool)) continue
		if (isEffect(entry)) rows.push({ tool, pattern: '', effect: entry })
		else {
			const patterns = plain(entry)
			if (!patterns) continue
			for (const [pattern, effect] of Object.entries(patterns))
				if (isEffect(effect)) rows.push({ tool, pattern, effect })
		}
	}
	return rows
}

/** A rule as a sentence names it. */
export function permissionRuleName(row: { tool: string; pattern: string }): string {
	return row.pattern === '' ? `${row.tool} (every call)` : `${row.tool} "${row.pattern}"`
}

/**
 * The rule table the rows save: a tool with one row and no pattern is `tool: effect`, a tool with
 * patterns is `tool: { pattern: effect }`. A row with no pattern beside rows with one is written
 * as the pattern `*`, which means the same. The table is refused, in plain words, when a tool is
 * missing or is one of the mode keys, when `sources` has no source, or when a rule is listed twice.
 */
export function permissionRulesTable(
	rows: readonly PermissionRuleRow[],
): { value: Record<string, unknown> } | { error: string } {
	const byTool = new Map<string, PermissionRuleRow[]>()
	for (const row of rows) {
		const tool = row.tool.trim()
		if (tool === '') return { error: 'Enter a tool for each rule, such as bash.' }
		if (/\s/.test(tool))
			return { error: `"${tool}" is not a tool name: a tool is one word, such as bash.` }
		if (PERMISSION_MODE_KEYS.includes(tool))
			return { error: `${tool} is a permission setting with a row of its own, not a tool.` }
		if (!isEffect(row.effect)) return { error: `Choose allow, ask or deny for ${tool}.` }
		const pattern = row.pattern.trim()
		if (tool === 'sources' && pattern === '')
			return { error: 'A sources rule needs a source, such as an id or a pattern of ids.' }
		byTool.set(tool, [...(byTool.get(tool) ?? []), { tool, pattern, effect: row.effect }])
	}
	const value: Record<string, unknown> = {}
	for (const [tool, list] of byTool) {
		if (list.length === 1 && list[0]?.pattern === '') {
			value[tool] = list[0].effect
			continue
		}
		const patterns: Record<string, string> = {}
		for (const row of list) {
			const pattern = row.pattern === '' ? '*' : row.pattern
			if (pattern in patterns)
				return { error: `${permissionRuleName({ tool, pattern: row.pattern })} is listed twice.` }
			patterns[pattern] = row.effect
		}
		value[tool] = patterns
	}
	return { value }
}

/** How much a rule lets run without a person: deny, then ask, then allow. */
const PERMISSIVE = { deny: 0, ask: 1, allow: 2 } as const

export interface RuleLoosened {
	readonly kind: 'added' | 'changed' | 'removed'
	readonly tool: string
	readonly pattern: string
	/** What the rule says after the change; for a removal, what it said. */
	readonly effect: string
	/** What a changed rule said before. */
	readonly was?: string
}

/**
 * What a change to the rules lets run that did not before: a rule that allows added, a rule
 * changed to a more permissive answer, a deny or ask rule removed. Anything that only restricts
 * is not listed.
 */
export function permissionRulesLoosened(current: unknown, value: unknown): RuleLoosened[] {
	const key = (row: PermissionRuleRow): string => `${row.tool}\u0000${row.pattern}`
	const before = new Map(permissionRuleRows(current).map((row) => [key(row), row]))
	const after = new Map(permissionRuleRows(value).map((row) => [key(row), row]))
	const out: RuleLoosened[] = []
	for (const [id, row] of after) {
		const had = before.get(id)
		if (had === undefined) {
			if (row.effect === 'allow')
				out.push({ kind: 'added', tool: row.tool, pattern: row.pattern, effect: row.effect })
		} else if (
			PERMISSIVE[row.effect as keyof typeof PERMISSIVE] >
			PERMISSIVE[had.effect as keyof typeof PERMISSIVE]
		)
			out.push({
				kind: 'changed',
				tool: row.tool,
				pattern: row.pattern,
				effect: row.effect,
				was: had.effect,
			})
	}
	for (const [id, row] of before)
		if (!after.has(id) && row.effect !== 'allow')
			out.push({ kind: 'removed', tool: row.tool, pattern: row.pattern, effect: row.effect })
	return out
}

/** The sentence asked first, naming each rule that lets more run. */
export function permissionRulesConfirmation(
	sentence: string,
	current: unknown,
	value: unknown,
): string {
	const parts = permissionRulesLoosened(current, value).map((change) => {
		const name = permissionRuleName(change)
		if (change.kind === 'added') return `${name} is allowed without asking.`
		if (change.kind === 'changed') return `${name} goes from ${change.was} to ${change.effect}.`
		return `The ${change.effect} rule for ${name} is removed.`
	})
	return parts.length === 0 ? sentence : `${sentence} ${parts.join(' ')}`
}

export function permissionRulesWords(value: unknown): string | undefined {
	if (!plain(value)) return undefined
	const rows = permissionRuleRows(value)
	return rows.length === 0
		? 'no rules'
		: rows.map((row) => `${permissionRuleName(row)} ${row.effect}`).join('; ')
}

/** One self-check as saved: kept as written so a bad one can be seen and fixed. */
export interface PermissionCheckRow {
	readonly tool: string
	readonly input: unknown
	readonly expect: string
}

/** The checks of a saved list, in order. An entry that is not a table of fields is left out. */
export function permissionCheckRows(saved: unknown): PermissionCheckRow[] {
	if (!Array.isArray(saved)) return []
	return saved.flatMap((entry) => {
		const check = plain(entry)
		if (!check) return []
		return [
			{
				tool: typeof check.tool === 'string' ? check.tool : '',
				input: check.input,
				expect: typeof check.expect === 'string' ? check.expect : '',
			},
		]
	})
}

/** The input of a check as one line of text: the command for a shell tool, JSON otherwise. */
export function checkInputText(
	row: { tool: string; input: unknown },
	commandTools: readonly string[],
	commandField: string,
): string {
	const input = plain(row.input)
	if (
		commandTools.includes(row.tool) &&
		input &&
		Object.keys(input).length === 1 &&
		typeof input[commandField] === 'string'
	)
		return input[commandField] as string
	return JSON.stringify(row.input ?? {})
}

/** Whether a check's input is shown as a command box. */
export function checkInputIsCommand(
	row: { tool: string; input: unknown },
	commandTools: readonly string[],
	commandField: string,
): boolean {
	const input = plain(row.input)
	return (
		commandTools.includes(row.tool) &&
		input !== undefined &&
		Object.keys(input).length === 1 &&
		typeof input[commandField] === 'string'
	)
}

/**
 * The input a check saves from what was typed: the command for a shell tool, an object written
 * as JSON for any other. The engine checks the rest (a tool, an answer) in its own words.
 */
export function checkInputFromText(
	tool: string,
	text: string,
	commandTools: readonly string[],
	commandField: string,
): { value: Record<string, unknown> } | { error: string } {
	if (commandTools.includes(tool.trim())) {
		if (text.trim() === '') return { error: 'Enter the command the check runs.' }
		return { value: { [commandField]: text } }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		return { error: `That is not valid JSON: ${(error as Error).message}` }
	}
	const input = plain(parsed)
	return input ? { value: input } : { error: 'The input is an object, such as {"path":"a.txt"}.' }
}

function checkName(row: PermissionCheckRow): string {
	const input = JSON.stringify(row.input ?? {})
	return `${row.tool} ${input.length > 60 ? `${input.slice(0, 57)}...` : input} must be ${row.expect}`
}

/** The checks that are gone from the new list, or changed (a changed check is a removed one). */
export function permissionChecksRemoved(current: unknown, value: unknown): PermissionCheckRow[] {
	const kept = new Set(permissionCheckRows(value).map((row) => JSON.stringify(row)))
	return permissionCheckRows(current).filter((row) => !kept.has(JSON.stringify(row)))
}

export function permissionChecksConfirmation(
	sentence: string,
	current: unknown,
	value: unknown,
): string {
	const gone = permissionChecksRemoved(current, value)
	return gone.length === 0
		? sentence
		: `${sentence} Removed or changed: ${gone.map(checkName).join('; ')}.`
}

export function permissionChecksWords(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined
	const rows = permissionCheckRows(value)
	return rows.length === 0 ? 'no checks' : rows.map(checkName).join('; ')
}

/** The sites of a saved map without the line for every other site, and that line's level. */
export function siteRows(saved: unknown): {
	sites: { site: string; level: string }[]
	other: string
} {
	const held = plain(saved) ?? {}
	const sites: { site: string; level: string }[] = []
	for (const [site, level] of Object.entries(held))
		if (site.trim() !== '*' && typeof level === 'string') sites.push({ site, level })
	const other = typeof held['*'] === 'string' ? held['*'] : ''
	return { sites, other }
}

/**
 * The map the lines save, `*` last and only when it is not left at the engine's default (`other`
 * empty). A line with no site, or a site on two lines, is refused in plain words.
 */
export function sitesValue(
	sites: readonly { site: string; level: string }[],
	other: string,
): { value: Record<string, string> } | { error: string } {
	const value: Record<string, string> = {}
	for (const row of sites) {
		const site = row.site.trim()
		if (site === '') return { error: 'Enter a site for each line, such as https://example.com.' }
		if (site === '*') return { error: 'The last line is every other site; do not add * here.' }
		if (site in value) return { error: `${site} is listed twice.` }
		value[site] = row.level
	}
	if (other !== '') value['*'] = other
	return { value }
}

/** What a site reads as: its own line, else the line for every other site, else the default. */
function siteLevel(table: Record<string, string>, site: string, fallback: string): string {
	return table[site] ?? (site === '*' ? undefined : table['*']) ?? fallback
}

export interface SiteLoosened {
	/** The site, or `*` for every other site. */
	readonly site: string
	readonly now: string
	readonly was: string
}

const levelTable = (value: unknown): Record<string, string> => {
	const out: Record<string, string> = {}
	for (const [site, level] of Object.entries(plain(value) ?? {}))
		if (typeof level === 'string') out[site.trim()] = level
	return out
}

/**
 * The sites that become `act`, and the sites that stop being `deny`, counting a site with no line
 * as the line for every other site. Setting a site to deny, read or ask never asks on its own.
 */
export function sitesLoosened(
	current: unknown,
	value: unknown,
	defaultLevel = 'ask',
): SiteLoosened[] {
	const before = levelTable(current)
	const after = levelTable(value)
	const out: SiteLoosened[] = []
	for (const site of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const was = siteLevel(before, site, defaultLevel)
		const now = siteLevel(after, site, defaultLevel)
		if ((now === 'act' && was !== 'act') || (was === 'deny' && now !== 'deny'))
			out.push({ site, was, now })
	}
	return out
}

export function sitesConfirmation(
	sentence: string,
	current: unknown,
	value: unknown,
	defaultLevel = 'ask',
): string {
	const parts = sitesLoosened(current, value, defaultLevel).map((change) => {
		const name = change.site === '*' ? 'every other site' : change.site
		return change.now === 'act'
			? `Namzu may click and type on ${name}.`
			: `${name} is no longer denied; it is now ${change.now}.`
	})
	return parts.length === 0 ? sentence : `${sentence} ${parts.join(' ')}`
}

export function sitesWords(
	control: { levels: readonly ConfigSettingOption[]; defaultLevel: string },
	value: unknown,
): string | undefined {
	if (!plain(value)) return undefined
	const { sites, other } = siteRows(value)
	const parts = sites.map((row) => `${row.site} ${labelOf(control.levels, row.level)}`)
	parts.push(
		`every other site ${labelOf(control.levels, other === '' ? control.defaultLevel : other)}`,
	)
	return parts.join('; ')
}

/** Whether a change to a `loosens` setting asks first, by the kind of control it has. */
export function loosenAsks(
	control: ConfigSettingControl,
	current: unknown,
	value: unknown,
): boolean {
	switch (control.kind) {
		case 'permission-rules':
			return permissionRulesLoosened(current, value).length > 0
		case 'permission-checks':
			return permissionChecksRemoved(current, value).length > 0
		case 'sites':
			return sitesLoosened(current, value, control.defaultLevel).length > 0
		default:
			return autoModeAsks(current, value)
	}
}

/** The sentence asked first for a `loosens` setting. */
export function loosenConfirmation(
	sentence: string,
	control: ConfigSettingControl,
	current: unknown,
	value: unknown,
): string {
	switch (control.kind) {
		case 'permission-rules':
			return permissionRulesConfirmation(sentence, current, value)
		case 'permission-checks':
			return permissionChecksConfirmation(sentence, current, value)
		case 'sites':
			return sitesConfirmation(sentence, current, value, control.defaultLevel)
		case 'auto-mode':
			return autoModeConfirmation(sentence, current, value, control.lists)
		default:
			return sentence
	}
}

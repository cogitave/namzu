/**
 * Read and write the settings Desktop shows, against the user config file.
 *
 * Every write is checked twice before it touches the file: the value must suit
 * its control, and the loader's own reader for that key must accept the whole
 * block it would produce. A secret-bearing or command-running setting (a
 * `file-only` control) is never read out or written here.
 */

import { existsSync, readFileSync } from 'node:fs'
import { parse as yamlParse } from 'yaml'

import { canonicalBrowserSiteKey, isBrowserSiteLevel } from '../permissions/browser-sites.js'
import { permissionCheckProblem } from '../permissions/checks.js'
import { foldRuleLists } from '../permissions/rule-strings.js'
import { compilePermissions } from '../permissions/rules.js'
import { parsePrefix } from '../workspaces/prefix.js'
import { BROWSER_PROFILE_NAME, ConfigValueError, readConfigKey } from './load.js'
import { layerReader } from './setting-layers.js'
import {
	PERMISSION_MODE_KEYS,
	levelsValue,
	listControlWords,
	permissionRuleName,
	permissionRuleRows,
	permissionRulesTable,
	sameSet,
	screenNames,
	screenTools,
	screensValue,
	toolSpellingProblem,
} from './setting-values.js'
import {
	SETTING_DESCRIPTORS,
	SETTING_GROUP_LABELS,
	type SettingDescriptor,
	type SettingSection,
} from './settings-descriptors.js'
import {
	type UserConfigWriteOptions,
	deleteUserConfigValue,
	setUserConfigValue,
	userConfigPath,
	withUserConfigLock,
} from './user-config.js'
import {
	branchPrefixProblem,
	sparseFolderProblem,
	worktreeLocationProblem,
} from './worktree-settings.js'

export interface SettingState {
	readonly path: string
	/** Written in the user file. Absent means the default (or a project file) applies. */
	readonly set: boolean
	/** The value, as JSON text for a list or table. Never present for a `file-only` setting. */
	readonly value?: unknown
	/**
	 * Which layer decides the value in force, when it is not the user file: `project` (the project's
	 * own file), `local` (its git-ignored file), `managed` (the administrator's file) or `env` (an
	 * environment variable). Absent means the user file, or the default when nothing is saved. A
	 * Desktop older than the field ignores it and keeps showing the saved value.
	 */
	readonly layer?: 'user' | 'project' | 'local' | 'profile' | 'managed' | 'env'
	/** The value in force, as that layer gives it. Present with `layer`, unless an environment value is unusable. */
	readonly effective?: unknown
	/**
	 * An environment variable set for this process that the loader uses in place of the saved value.
	 * Only for a setting whose variable is described in `ENVIRONMENT_BINDINGS`; the value is a model
	 * name, size, switch or channel, never a secret.
	 */
	readonly env?: { readonly variable: string; readonly value: string }
	/**
	 * Only on `permissions.allowBypassMode`: who has set `permissions.disableBypassMode`, which beats
	 * the opt-in. `user` is the user file, `managed` the administrator's file, `project` and `local`
	 * the project's files. Absent means nothing forbids the mode.
	 */
	readonly turnedOffBy?: 'user' | 'project' | 'local' | 'managed'
}

export interface ReadSettingsOptions extends UserConfigWriteOptions {
	/** The folder whose project files count; defaults to the process's. */
	readonly cwd?: string
	/** Overridable for tests; defaults to the machine-wide managed file. */
	readonly managedPath?: string
}

export interface SettingsSnapshot {
	readonly file: string
	readonly settings: readonly SettingState[]
	readonly descriptors: readonly SettingDescriptor[]
}

function descriptorFor(path: string): SettingDescriptor {
	const found = SETTING_DESCRIPTORS.find((entry) => entry.path === path)
	if (!found) throw new Error('That is not a setting Namzu can change here.')
	return found
}

function readUserDocument(opts: UserConfigWriteOptions): Record<string, unknown> {
	const file = userConfigPath(opts)
	if (!existsSync(file)) return {}
	let parsed: unknown
	try {
		parsed = yamlParse(readFileSync(file, 'utf8'))
	} catch (cause) {
		// Say which file and where, in one sentence; Desktop adds what to do, the terminal its own.
		const at = (cause as { linePos?: ReadonlyArray<{ line: number; col: number }> } | null)
			?.linePos?.[0]
		const where = at === undefined ? '' : ` (line ${at.line}, column ${at.col})`
		throw new Error(`${file} isn't valid YAML${where}.`)
	}
	if (parsed === null || parsed === undefined) return {}
	if (typeof parsed !== 'object' || Array.isArray(parsed))
		throw new Error(`${file} is not a mapping of settings; fix it first`)
	return parsed as Record<string, unknown>
}

function lookup(doc: Record<string, unknown>, path: readonly string[]): unknown {
	let at: unknown = doc
	for (const segment of path) {
		if (at === null || typeof at !== 'object' || Array.isArray(at)) return undefined
		at = (at as Record<string, unknown>)[segment]
	}
	return at
}

/**
 * A Desktop older than the typed default reads only `defaultText`. Fill it from the typed value so
 * that an app built before `default` existed still shows a default, in the words of the option.
 */
export function withDefaultText(
	entry: SettingDescriptor,
): SettingDescriptor & { readonly groupLabel?: string } {
	const filled = withTypedDefaultText(entry)
	// Sent with the id so a screen draws the heading without a second copy of the words.
	return entry.group ? { ...filled, groupLabel: SETTING_GROUP_LABELS[entry.group] } : filled
}

function withTypedDefaultText(entry: SettingDescriptor): SettingDescriptor {
	if (entry.defaultText !== undefined || entry.default === undefined) return entry
	const control = entry.control
	const value = entry.default
	let text: string
	const listed = listControlWords(control, value)
	if (listed !== undefined) text = listed
	else if (typeof value === 'boolean') text = value ? 'on' : 'off'
	else if (Array.isArray(value)) {
		const options = control.kind === 'checks' ? control.options : []
		text =
			value.length === 0
				? 'none'
				: value
						.map((item) => options.find((option) => option.value === item)?.label ?? item)
						.join(', ')
	} else if (control.kind === 'select')
		text = control.options.find((option) => option.value === value)?.label ?? String(value)
	else text = String(value)
	return { ...entry, defaultText: entry.defaultNote ? `${text}. ${entry.defaultNote}` : text }
}

const WORKSPACES_PREFIX = 'tui.workspacesPrefix'
const LEGACY_SPACES_PREFIX = 'tui.spacesPrefix'

/** Rows whose layers combine by tightening or by merging tables: one layer's value is not the answer. */
const NOT_LAYERED = ['file-only', 'permission-rules', 'permission-checks', 'routing', 'auto-mode']

const ALLOW_BYPASS = 'permissions.allowBypassMode'
/** A file-only key with no row: it still forbids bypass mode, whoever sets it. */
const FORBID_BYPASS = 'permissions.disableBypassMode'

/** Who forbids bypass mode, strongest layer first, or `undefined` when no layer does. */
function bypassForbiddenBy(
	doc: Record<string, unknown>,
	answer: ReturnType<ReturnType<typeof layerReader>>,
): SettingState['turnedOffBy'] {
	if (
		answer?.effective === true &&
		(answer.layer === 'managed' || answer.layer === 'local' || answer.layer === 'project')
	)
		return answer.layer
	return lookup(doc, FORBID_BYPASS.split('.')) === true ? 'user' : undefined
}

export function readSettings(opts: ReadSettingsOptions = {}): SettingsSnapshot {
	const doc = readUserDocument(opts)
	const layerOf = layerReader({
		env: opts.env ?? process.env,
		cwd: opts.cwd ?? process.cwd(),
		...(opts.managedPath ? { managedPath: opts.managedPath } : {}),
	})
	const settings = SETTING_DESCRIPTORS.map((entry): SettingState => {
		let value = lookup(doc, entry.path.split('.'))
		// The key from before the rename is read by the loader while the new one is absent.
		if (value === undefined && entry.path === WORKSPACES_PREFIX)
			value = lookup(doc, LEGACY_SPACES_PREFIX.split('.'))
		// The rule editor's value is the rules alone, the mode keys beside them being other rows.
		if (entry.control.kind === 'permission-rules') {
			const rules = ruleTableOf(value)
			value = Object.keys(rules).length === 0 ? undefined : rules
		}
		const answer = NOT_LAYERED.includes(entry.control.kind) ? undefined : layerOf(entry.path)
		const forbidden =
			entry.path === ALLOW_BYPASS ? bypassForbiddenBy(doc, layerOf(FORBID_BYPASS)) : undefined
		const decided = answer
			? {
					layer: answer.layer,
					...(answer.effective !== undefined ? { effective: answer.effective } : {}),
					...(answer.env ? { env: answer.env } : {}),
				}
			: {}
		const turnedOff = forbidden ? { turnedOffBy: forbidden } : {}
		if (value === undefined) return { path: entry.path, set: false, ...decided, ...turnedOff }
		if (entry.control.kind === 'file-only') return { path: entry.path, set: true }
		return { path: entry.path, set: true, value, ...decided, ...turnedOff }
	})
	return {
		file: userConfigPath(opts),
		settings,
		descriptors: SETTING_DESCRIPTORS.map(withDefaultText),
	}
}

/**
 * The rules of a saved `permissions` table as the per-tool table the engine compiles: the mode keys
 * left out, and the `allow`, `ask` and `deny` lists of `Tool(specifier)` strings folded in, as the
 * loader folds them. A list the loader would refuse is left out here, so reading never throws.
 */
export function ruleTableOf(raw: unknown): Record<string, unknown> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
	const folded = foldRuleLists(raw as Record<string, unknown>)
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(folded.table))
		if (!PERMISSION_MODE_KEYS.includes(key)) out[key] = value
	return out
}

function wordsList(raw: unknown, what: string): string[] {
	if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) throw new Error(what)
	return raw as string[]
}

function choosable(values: readonly string[], allowed: readonly string[]): void {
	if (values.some((v) => !allowed.includes(v)))
		throw new Error(`Choose from: ${allowed.join(', ')}.`)
}

/**
 * A value read as its control reads it. `undefined` comes back for a value that means the same as
 * the key being absent (every event ticked, every trigger at its default), so the key is removed
 * rather than written with a list that would stop following the default.
 */
function coerce(entry: SettingDescriptor, raw: unknown): unknown {
	const control = entry.control
	switch (control.kind) {
		case 'toggle':
			if (typeof raw !== 'boolean') throw new Error('Choose on or off.')
			return raw
		case 'select':
			if (typeof raw !== 'string' || !control.options.some((o) => o.value === raw))
				throw new Error(`Choose one of: ${control.options.map((o) => o.value).join(', ')}.`)
			return raw
		case 'checks': {
			const list = wordsList(raw, 'Choose from the list.')
			const allowed = control.options.map((o) => o.value)
			choosable(list, allowed)
			// With every choice ticked, nothing is saved: a missing key means all, new kinds too.
			if (control.allLabel && sameSet(list, allowed)) return undefined
			return list
		}
		case 'toggle-checks': {
			if (typeof raw === 'boolean') return raw
			const list = wordsList(raw, 'Choose on, off or events from the list.')
			choosable(
				list,
				control.options.map((o) => o.value),
			)
			return list
		}
		case 'toggle-list': {
			const list = wordsList(raw, 'Choose on or off.')
			if (sameSet(list, control.on)) return [...control.on]
			if (sameSet(list, control.off)) return [...control.off]
			throw new Error('Choose on or off.')
		}
		case 'key': {
			if (typeof raw !== 'string') throw new Error('Choose a key.')
			// The loader's own reader names the keys it refuses; this only spells the key as it writes it.
			return parsePrefix(raw)?.name ?? raw.trim()
		}
		case 'levels': {
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
				throw new Error('Choose a level for each entry.')
			const ids = control.entries.map((e) => e.value)
			const levels = control.levels.map((l) => l.value)
			for (const [id, level] of Object.entries(raw)) {
				if (!ids.includes(id)) throw new Error(`Choose from: ${ids.join(', ')}.`)
				if (typeof level !== 'string' || !levels.includes(level))
					throw new Error(`Choose a level for ${id}: ${levels.join(', ')}.`)
			}
			return levelsValue(raw as Record<string, string>, entry.default)
		}
		case 'screens': {
			if (!Array.isArray(raw)) throw new Error('Choose from the list.')
			const allowed = control.options.map((o) => o.value)
			const names = screenNames(raw)
			if (names.length !== raw.length) throw new Error('Choose from the list.')
			choosable(names, allowed)
			const { screen, field } = control.passthrough
			for (const entry of raw) {
				if (typeof entry === 'string') continue
				const { name, ...options } = entry as Record<string, unknown>
				for (const key of Object.keys(options))
					if (!(name === screen && key === field))
						throw new Error(`${key} is not an option of the "${String(name)}" screen.`)
				const tools = options[field]
				if (
					tools !== undefined &&
					(!Array.isArray(tools) || tools.some((t) => typeof t !== 'string'))
				)
					throw new Error(`${field} must be a list of tool names.`)
			}
			const tools = screenTools(raw, screen, field)
			if (tools.some((tool) => tool.trim() === '')) throw new Error('Enter a tool name.')
			// An exemption on a screen that is not ticked has nothing to attach to.
			if (tools.length > 0 && !names.includes(screen))
				throw new Error(`${field} belongs to the ${screen} screen, which is not chosen.`)
			return screensValue(names, tools, control, entry.default) === undefined
				? undefined
				: normaliseScreens(raw, screen, field)
		}
		case 'list': {
			const list = wordsList(raw, 'Enter a list of words.')
			if (list.some((item) => item.trim() === '' || item.length > 2000))
				throw new Error(`Enter a ${control.itemLabel} of 1 to 2000 characters.`)
			const words = list.map((item) => item.trim())
			// An empty list is the default for a setting whose default is none: the key goes.
			if (words.length === 0 && Array.isArray(entry.default) && entry.default.length === 0)
				return undefined
			return words
		}
		case 'number':
			if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('Enter a number.')
			if (control.min !== undefined && raw < control.min)
				throw new Error(`Enter ${control.min} or more.`)
			if (control.max !== undefined && raw > control.max)
				throw new Error(`Enter ${control.max} or less.`)
			return raw
		case 'text': {
			if (typeof raw !== 'string') throw new Error('Enter some text.')
			const text = raw.trim()
			if (text.length === 0 || text.length > 2000)
				throw new Error('Enter between 1 and 2000 characters.')
			return text
		}
		case 'model': {
			if (typeof raw !== 'string') throw new Error('Enter a model.')
			const name = raw.trim()
			if (name.length === 0 || name.length > 2000)
				throw new Error('Enter between 1 and 2000 characters.')
			return name
		}
		case 'routing': {
			const table = plainTable(raw, 'Fill in the routing form.')
			// The loader reads provider and model out of each target; this only keeps the file tidy.
			return table
		}
		case 'auto-mode': {
			const table = plainTable(raw, 'Fill in the reviewer form.')
			for (const list of control.lists) {
				const items = table[list.value]
				if (items === undefined) continue
				if (!Array.isArray(items) || items.some((item) => typeof item !== 'string'))
					throw new Error(`${list.label} must be a list of sentences.`)
				if (items.some((item) => item.trim() === '' || item.length > 2000))
					throw new Error(`Each entry of ${list.label} takes 1 to 2000 characters.`)
				table[list.value] = items.map((item: string) => item.trim())
			}
			// A table with nothing in it is the same as no table: the built-in rules.
			return Object.keys(table).length === 0 ? undefined : table
		}
		case 'permission-rules': {
			const table = plainTable(jsonValue(raw), 'permissions must be a mapping of tool names.')
			for (const key of Object.keys(table))
				if (PERMISSION_MODE_KEYS.includes(key))
					throw new Error(
						`${key} is a permission setting with a row of its own; this one holds only the tool rules.`,
					)
			const folded = foldRuleLists(table)
			if (folded.problem)
				throw new Error(`${folded.problem.path.join('.')}: ${folded.problem.message}`)
			// The engine's own compiler names a rule it cannot read, as it does at start-up.
			const problem = compilePermissions(folded.table as never).diagnostics[0]
			if (problem)
				throw new Error(
					`${permissionRuleName({ tool: problem.tool, pattern: problem.pattern ?? '' })}: ${problem.message}`,
				)
			const rows = permissionRuleRows(folded.table)
			const saved = permissionRulesTable(rows)
			if ('error' in saved) throw new Error(saved.error)
			return saved.value
		}
		case 'permission-checks': {
			const list = jsonValue(raw)
			if (!Array.isArray(list)) throw new Error('permissionChecks must be a list.')
			const checks = list.map((check, index) => {
				const tool = typeof check?.tool === 'string' ? check.tool.trim() : check?.tool
				const problem = permissionCheckProblem({ ...check, tool }, index)
				if (problem) throw new Error(`${problem.tool}: ${problem.message}`)
				const wrong = toolSpellingProblem(tool)
				if (wrong) throw new Error(`permissionChecks[${index}]: ${wrong}`)
				return { tool, input: check.input, expect: check.expect }
			})
			// A list with no check in it is the same as no list.
			return checks.length === 0 ? undefined : checks
		}
		case 'sites': {
			const table = plainTable(jsonValue(raw), 'browser.sites must be a mapping of site to level.')
			const sites: Record<string, string> = {}
			for (const [site, level] of Object.entries(table)) {
				// The loader's own words, with the site named.
				if (!isBrowserSiteLevel(level)) throw new Error(`${site}: must be deny, read, ask or act`)
				const verdict = canonicalBrowserSiteKey(site)
				if (!verdict.ok) throw new Error(`${site}: ${verdict.reason}`)
				if (verdict.key in sites) throw new Error(`${verdict.key} is listed twice.`)
				sites[verdict.key] = level
			}
			// The line for every other site is written last, as the loader reads it last.
			const { '*': other, ...named } = sites
			const ordered = other === undefined ? named : { ...named, '*': other }
			return Object.keys(ordered).length === 0 ? undefined : ordered
		}
		case 'json': {
			if (typeof raw !== 'string') throw new Error('Enter JSON.')
			if (raw.length > 100_000) throw new Error('That is too long.')
			try {
				return JSON.parse(raw) as unknown
			} catch (error) {
				throw new Error(`That is not valid JSON: ${(error as Error).message}`)
			}
		}
		case 'file-only':
			throw new Error('Edit this one in the config file; Desktop does not show or change it.')
	}
}

/** A value sent as JSON text (an older screen does) is read as the value it holds. */
function jsonValue(raw: unknown): unknown {
	if (typeof raw !== 'string') return raw
	if (raw.length > 100_000) throw new Error('That is too long.')
	try {
		return JSON.parse(raw) as unknown
	} catch (error) {
		throw new Error(`That is not valid JSON: ${(error as Error).message}`)
	}
}

/** A table of settings, copied so tidying it never changes what the caller holds. */
function plainTable(raw: unknown, wrong: string): Record<string, unknown> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(wrong)
	return { ...(raw as Record<string, unknown>) }
}

/** The list as written, with a screen's tools trimmed and deduplicated and blank ones dropped. */
function normaliseScreens(raw: unknown[], screen: string, field: string): unknown[] {
	return raw.map((entry) => {
		if (typeof entry === 'string') return entry
		const name = (entry as { name: string }).name
		if (name !== screen) return name
		const tools = [...new Set(screenTools([entry], screen, field).map((t) => t.trim()))]
		return tools.length > 0 ? { name, [field]: tools } : name
	})
}

/**
 * Checks the loader makes across keys, which a per-key reader cannot see. Today there is one:
 * `model: auto` needs `routing.default` to fall back to, and the loader refuses the whole file
 * without it. Desktop must never write a file the terminal app then refuses to load, whether the
 * change sets the model or removes the routing it depends on.
 */
export function checkAcrossKeys(
	doc: Record<string, unknown>,
	path: readonly string[],
	value: unknown | undefined,
): void {
	const root = path[0]
	if (root !== 'model' && root !== 'routing') return
	const after: Record<string, unknown> = { ...doc }
	if (path.length === 1) {
		if (value === undefined) delete after[root]
		else after[root] = value
	}
	if (after.model !== 'auto') return
	const routing = after.routing
	const hasDefault =
		routing !== null &&
		typeof routing === 'object' &&
		!Array.isArray(routing) &&
		(routing as Record<string, unknown>).default !== undefined
	if (hasDefault) return
	throw new Error(
		root === 'model'
			? 'Choose Automatic only after the routing setting below has a default model. Without one, Namzu cannot start.'
			: 'The model is set to Automatic, which needs a default model in routing. Choose another model first, or keep a default here.',
	)
}

/** Checks on one value that its control alone does not make. Each says its rule in plain words. */
const VALUE_CHECKS: Readonly<Record<string, (value: unknown) => void>> = {
	'worktrees.branchPrefix': (value) => {
		const problem = branchPrefixProblem(String(value))
		if (problem) throw new Error(problem)
	},
	// The folder is looked at when it is saved, so a typo is refused here and not at the next
	// worktree. It is looked at again when the worktree is made.
	'worktrees.location': (value) => {
		const problem = worktreeLocationProblem(String(value))
		if (problem) throw new Error(problem)
	},
	'worktrees.sparseFolders': (value) => {
		for (const item of Array.isArray(value) ? value : []) {
			const problem = sparseFolderProblem(String(item))
			if (problem) throw new Error(problem)
		}
	},
	'browser.defaultProfile': (value) => {
		const name = String(value)
		if (name.length > 64 || !BROWSER_PROFILE_NAME.test(name))
			throw new Error(
				'Use lowercase letters and digits, with single dashes between them, up to 64 characters.',
			)
	},
	'telemetry.otlp.endpoint': (value) => {
		let url: URL
		try {
			url = new URL(String(value))
		} catch {
			throw new Error('Enter a full web address that starts with http or https.')
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:')
			throw new Error('The address must start with http or https.')
		if (url.username !== '' || url.password !== '')
			throw new Error('Do not put a user name or password in the address.')
	},
}

/**
 * `learningGenerator` may be written as a plain true or false. Writing one of its numbers next to
 * that keeps the choice: the switch becomes `enabled` inside a mapping, rather than the write
 * failing or the switch being lost.
 */
function expandLearningSwitch(doc: Record<string, unknown>, path: readonly string[]): void {
	if (path[0] !== 'learningGenerator' || path.length < 2) return
	if (typeof doc.learningGenerator === 'boolean')
		doc.learningGenerator = { enabled: doc.learningGenerator }
}

/** Whether the file already holds a value at this place under its top-level key. */
function holdsKey(block: unknown, rest: readonly string[]): boolean {
	let at: unknown = block
	for (const segment of rest) {
		if (!at || typeof at !== 'object' || Array.isArray(at) || !(segment in at)) return false
		at = (at as Record<string, unknown>)[segment]
	}
	return true
}

/** Validate against the loader as it would read the file after the change. */
function checkWhole(
	doc: Record<string, unknown>,
	path: readonly string[],
	value: unknown | undefined,
	file: string,
): void {
	const [root, ...rest] = path as [string, ...string[]]
	let block: unknown
	if (rest.length === 0) block = value
	else if (value === undefined && !holdsKey(doc[root], rest)) return
	else {
		const current = doc[root]
		const base =
			current && typeof current === 'object' && !Array.isArray(current)
				? structuredClone(current as Record<string, unknown>)
				: {}
		let at = base as Record<string, unknown>
		for (const segment of rest.slice(0, -1)) {
			const next = at[segment]
			if (!next || typeof next !== 'object' || Array.isArray(next)) at[segment] = {}
			at = at[segment] as Record<string, unknown>
		}
		const last = rest[rest.length - 1] as string
		if (value === undefined) delete at[last]
		else at[last] = value
		block = base
	}
	if (block === undefined) return
	try {
		readConfigKey(root, block, file)
	} catch (error) {
		// The save-to-file choices only mean something beside a destination; the loader's own
		// sentence about the missing one would name a field the person did not touch.
		if (
			error instanceof ConfigValueError &&
			path.join('.').startsWith('telemetry.sessionExport.') &&
			path.join('.') !== SESSION_EXPORT_DESTINATION &&
			!holdsKey(doc[root], ['sessionExport', 'destination'])
		)
			throw new Error(
				'Choose where to save conversations first (the destination), then change this.',
			)
		if (error instanceof ConfigValueError) throw new Error(error.message)
		throw error
	}
}

export interface SettingChange {
	readonly path: string
	/** Absent clears the setting so the default applies again. */
	readonly value?: unknown
}

export function describeChange(path: string): { confirm?: string; section: SettingSection } {
	const entry = descriptorFor(path)
	return { section: entry.section, ...(entry.confirm ? { confirm: entry.confirm } : {}) }
}

/**
 * Checks a change the way a write would, and touches nothing. Desktop asks this before it shows a
 * confirmation, so a value that would be refused never costs the person a dialog.
 */
export function checkSetting(change: SettingChange, opts: UserConfigWriteOptions = {}): void {
	prepare(change, opts)
}

/**
 * The save-to-file destination cannot be removed alone: the loader refuses a `sessionExport`
 * block that has no destination. Clearing it removes the whole block, which is what stopping the
 * saving means; the choices beside it were only meaningful with a destination.
 */
const SESSION_EXPORT_DESTINATION = 'telemetry.sessionExport.destination'

function prepare(
	change: SettingChange,
	opts: UserConfigWriteOptions,
): { path: string[]; value: unknown | undefined } {
	const entry = descriptorFor(change.path)
	let path = entry.path.split('.')
	const file = userConfigPath(opts)
	const doc = readUserDocument(opts)
	if (entry.control.kind === 'permission-rules') {
		// Only the rules change. The mode keys beside them are other settings and stay as written.
		const rules =
			change.value === undefined || change.value === null
				? {}
				: (coerce(entry, change.value) as Record<string, unknown>)
		const kept: Record<string, unknown> = {}
		const held = doc.permissions
		if (typeof held === 'object' && held !== null && !Array.isArray(held))
			for (const key of PERMISSION_MODE_KEYS)
				if (key in held) kept[key] = (held as Record<string, unknown>)[key]
		const merged = { ...kept, ...rules }
		const whole = Object.keys(merged).length === 0 ? undefined : merged
		checkWhole(doc, path, whole, file)
		return { path, value: whole }
	}
	if (change.value === undefined || change.value === null) {
		if (entry.control.kind === 'file-only') throw new Error('Edit this one in the config file.')
		if (entry.path === SESSION_EXPORT_DESTINATION) path = ['telemetry', 'sessionExport']
		expandLearningSwitch(doc, path)
		checkAcrossKeys(doc, path, undefined)
		checkWhole(doc, path, undefined, file)
		return { path, value: undefined }
	}
	const value = coerce(entry, change.value)
	if (value === undefined) {
		// A value that means the same as no key: remove the key, as a clear does.
		checkAcrossKeys(doc, path, undefined)
		checkWhole(doc, path, undefined, file)
		return { path, value: undefined }
	}
	VALUE_CHECKS[entry.path]?.(value)
	expandLearningSwitch(doc, path)
	checkAcrossKeys(doc, path, value)
	checkWhole(doc, path, value, file)
	return { path, value }
}

/**
 * One lock across the whole save: the checks in `prepare` read the file, and the writes after them
 * must land on that same file, not on one another process changed in between.
 */
export function writeSetting(change: SettingChange, opts: UserConfigWriteOptions = {}): void {
	withUserConfigLock(() => {
		const { path, value } = prepare(change, opts)
		// Make a plain `learningGenerator: true|false` a mapping first, so the number goes beside it.
		if (path[0] === 'learningGenerator' && path.length > 1) {
			const doc = readUserDocument(opts)
			if (typeof doc.learningGenerator === 'boolean')
				setUserConfigValue(['learningGenerator'], { enabled: doc.learningGenerator }, opts)
		}
		if (value === undefined) deleteUserConfigValue(path, opts)
		else setUserConfigValue(path, value, opts)
		// The old name would otherwise stay behind and be read again once the new key goes.
		if (path.join('.') === WORKSPACES_PREFIX)
			deleteUserConfigValue(LEGACY_SPACES_PREFIX.split('.'), opts)
	}, opts)
}

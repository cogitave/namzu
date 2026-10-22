import type { PermissionModeName } from './mode-names.js'
import { PERMISSION_MODE_NAMES } from './mode-names.js'

/**
 * The settings that live beside the tool rules in the `permissions` table.
 *
 * A key of that table is a tool name, and its value an effect. These four are
 * not tools; they say which mode a session starts in, whether the two
 * no-prompt modes may be reached at all, and how the auto mode's classifier is
 * tuned. They are lifted out of the table when a config is loaded, so the rule
 * compiler never sees them, and the authority of the file they came from decides
 * which of them count.
 *
 * ## Who may say what
 *
 * A mode that stops asking is the operator's choice, never a repository's. A
 * project file that could write `defaultMode: bypass` would make every clone of
 * it a session that runs everything the moment someone opens it. So:
 *
 * - `defaultMode` of `bypass` or `auto` is honoured from the user's file and the
 *   managed file only. A project may still pick a stricter default.
 * - `disableBypassMode` and `disableAutoMode` can only close a door, so every
 *   file may write them, and a `true` in one file is not undone by another.
 * - `autoMode` names a model that receives the conversation and the rules that
 *   steer the classifier, so it is the operator's alone, like `routing`.
 */

/** The settings, after the layers have been combined. */
export interface PermissionSettings {
	/** The mode a session starts in when the command line names none. */
	readonly defaultMode?: PermissionModeName
	/** No session may enter bypass, whatever flag was given. */
	readonly disableBypassMode?: boolean
	/** No session may enter auto. */
	readonly disableAutoMode?: boolean
	readonly autoMode?: AutoModeSettings
	/**
	 * What was written and not honoured, one plain sentence each, so a person
	 * who put a setting in the wrong file is told rather than left to wonder.
	 */
	readonly ignored?: readonly string[]
}

/** How the auto mode's classifier is steered. Every list accepts the `"$defaults"` entry. */
export interface AutoModeSettings {
	/**
	 * The classifier's model: `provider:model`, a bare model of the session's
	 * provider, or `smallModel` for the side model. Absent: the session's own model.
	 */
	readonly model?: string
	readonly allow?: readonly string[]
	readonly softDeny?: readonly string[]
	readonly hardDeny?: readonly string[]
	readonly environment?: readonly string[]
}

/** The keys of the `permissions` table that are settings and not tool names. */
export const PERMISSION_SETTING_KEYS: readonly string[] = [
	'defaultMode',
	'disableBypassMode',
	'disableAutoMode',
	'autoMode',
]

const AUTO_MODE_KEYS = ['model', 'allow', 'softDeny', 'hardDeny', 'environment'] as const
const LIST_KEYS = ['allow', 'softDeny', 'hardDeny', 'environment'] as const

export function isPermissionSettingKey(key: string): boolean {
	return PERMISSION_SETTING_KEYS.includes(key)
}

/** The modes only an operator's own file may make a default: the two that stop asking. */
const OPERATOR_ONLY_DEFAULTS: readonly PermissionModeName[] = ['bypass', 'auto']

/**
 * What is wrong with the settings in one `permissions` table, or undefined.
 * The loader raises it as a config error so a typo is said at start-up.
 */
export function permissionSettingsProblem(
	table: Readonly<Record<string, unknown>>,
): { readonly path: readonly string[]; readonly message: string } | undefined {
	const mode = table.defaultMode
	if (mode !== undefined && !PERMISSION_MODE_NAMES.includes(mode as PermissionModeName)) {
		return {
			path: ['defaultMode'],
			message: `must be one of: ${PERMISSION_MODE_NAMES.join(', ')}`,
		}
	}
	for (const key of ['disableBypassMode', 'disableAutoMode'] as const) {
		if (table[key] !== undefined && typeof table[key] !== 'boolean') {
			return { path: [key], message: 'must be true or false' }
		}
	}
	const auto = table.autoMode
	if (auto === undefined) return undefined
	if (typeof auto !== 'object' || auto === null || Array.isArray(auto)) {
		return { path: ['autoMode'], message: 'must be a mapping' }
	}
	const entries = auto as Record<string, unknown>
	for (const key of Object.keys(entries)) {
		if (!(AUTO_MODE_KEYS as readonly string[]).includes(key)) {
			return {
				path: ['autoMode', key],
				message: `is not an auto mode setting (${AUTO_MODE_KEYS.join(', ')})`,
			}
		}
	}
	if (entries.model !== undefined && (typeof entries.model !== 'string' || !entries.model.trim())) {
		return { path: ['autoMode', 'model'], message: 'must be a model name' }
	}
	for (const key of LIST_KEYS) {
		const value = entries[key]
		if (
			value !== undefined &&
			!(Array.isArray(value) && value.every((v) => typeof v === 'string'))
		) {
			return { path: ['autoMode', key], message: 'must be a list of sentences' }
		}
	}
	return undefined
}

/** Whether a file speaks with the operator's authority or the workspace's. */
export type SettingsAuthority = 'operator' | 'workspace'

/**
 * Takes the settings out of one layer's `permissions` table.
 *
 * `rules` is the table without them; `settings` is what the layer's authority
 * lets stand; `ignored` says what it does not.
 */
export function splitPermissionsTable<T>(
	table: Readonly<Record<string, T>>,
	authority: SettingsAuthority,
	where: string,
): { rules: Record<string, T>; settings: PermissionSettings } {
	const rules: Record<string, T> = {}
	for (const [key, value] of Object.entries(table)) {
		if (!isPermissionSettingKey(key)) rules[key] = value
	}
	const raw = table as Readonly<Record<string, unknown>>
	const ignored: string[] = []
	let defaultMode: PermissionModeName | undefined
	if (typeof raw.defaultMode === 'string') {
		const mode = raw.defaultMode as PermissionModeName
		if (authority === 'workspace' && OPERATOR_ONLY_DEFAULTS.includes(mode)) {
			ignored.push(
				`permissions.defaultMode: "${mode}" in ${where} is ignored; a mode that stops asking is set in your own config file (~/.namzu/config.yaml).`,
			)
		} else {
			defaultMode = mode
		}
	}
	let autoMode: AutoModeSettings | undefined
	if (raw.autoMode !== undefined) {
		if (authority === 'workspace') {
			ignored.push(
				`permissions.autoMode in ${where} is ignored; the auto mode classifier is set in your own config file (~/.namzu/config.yaml).`,
			)
		} else {
			autoMode = raw.autoMode as AutoModeSettings
		}
	}
	return {
		rules,
		settings: {
			...(defaultMode ? { defaultMode } : {}),
			...(raw.disableBypassMode === true ? { disableBypassMode: true } : {}),
			...(raw.disableAutoMode === true ? { disableAutoMode: true } : {}),
			...(autoMode ? { autoMode } : {}),
			...(ignored.length > 0 ? { ignored } : {}),
		},
	}
}

/**
 * Combines the layers' settings, lowest precedence first. A later default
 * replaces an earlier one; a `true` that closes a mode stays; the classifier
 * settings of a later layer replace those of an earlier one key by key.
 */
export function mergePermissionSettings(
	base: PermissionSettings | undefined,
	next: PermissionSettings,
): PermissionSettings {
	const ignored = [...(base?.ignored ?? []), ...(next.ignored ?? [])]
	const autoMode =
		base?.autoMode || next.autoMode ? { ...base?.autoMode, ...next.autoMode } : undefined
	const defaultMode = next.defaultMode ?? base?.defaultMode
	return {
		...(defaultMode ? { defaultMode } : {}),
		...(base?.disableBypassMode || next.disableBypassMode ? { disableBypassMode: true } : {}),
		...(base?.disableAutoMode || next.disableAutoMode ? { disableAutoMode: true } : {}),
		...(autoMode ? { autoMode } : {}),
		...(ignored.length > 0 ? { ignored } : {}),
	}
}

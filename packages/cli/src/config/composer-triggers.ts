/**
 * `composerTriggers` beyond its shape: the built-in defaults, how the layers
 * of the config cascade combine, and the settings the interactive terminal
 * ends up with.
 *
 * The layers combine key by key, never by replacing the whole block, and a
 * project-controlled layer (the project file, or a profile it declares) can
 * only turn things down. So a repository cannot switch the feature back on
 * after the operator's user file turned it off, cannot raise a trigger from
 * `suggest` to `arm` (or from `off`), and cannot add a language the layers
 * below it left out. Every other layer — the user file, a profile the user
 * file declares, the managed file — replaces what is below it, per key.
 *
 * Nothing here matches text; that is `tui/triggers/`, which only the
 * interactive terminal imports.
 */

import type {
	ComposerTriggerArming,
	ComposerTriggerId,
	ComposerTriggerLanguage,
	ComposerTriggersConfig,
} from './schema.js'

export const COMPOSER_TRIGGER_IDS: readonly ComposerTriggerId[] = [
	'hypermode',
	'save-skill',
	'schedule',
	'max-effort',
]

export const COMPOSER_TRIGGER_LANGUAGES: readonly ComposerTriggerLanguage[] = ['en', 'tr']

/**
 * How each built-in arms when nothing says otherwise. A strict match of
 * `hypermode` or a save-as-skill phrase arms; schedule phrases, which
 * usually describe the code being written, are only offered; the
 * max-effort phrase is off until the operator turns it on.
 */
export const COMPOSER_TRIGGER_DEFAULTS: Readonly<Record<ComposerTriggerId, ComposerTriggerArming>> =
	{
		hypermode: 'arm',
		'save-skill': 'arm',
		schedule: 'suggest',
		'max-effort': 'off',
	}

const RANK: Readonly<Record<ComposerTriggerArming, number>> = { off: 0, suggest: 1, arm: 2 }

/** The settings the interactive terminal uses. */
export interface ResolvedComposerTriggers {
	readonly enabled: boolean
	readonly suggest: boolean
	readonly languages: readonly ComposerTriggerLanguage[]
	readonly arming: Readonly<Record<ComposerTriggerId, ComposerTriggerArming>>
}

export function resolveComposerTriggers(
	config: ComposerTriggersConfig | undefined,
): ResolvedComposerTriggers {
	return {
		enabled: config?.enabled ?? true,
		suggest: config?.suggest ?? true,
		languages: config?.languages ?? COMPOSER_TRIGGER_LANGUAGES,
		arming: { ...COMPOSER_TRIGGER_DEFAULTS, ...(config?.builtin ?? {}) },
	}
}

/**
 * `composerTriggers` from one more layer, over what the layers below said.
 * `projectControlled` is true for the project file and the profiles it
 * declares: those lower values and never raise them.
 */
export function mergeComposerTriggers(
	below: ComposerTriggersConfig | undefined,
	layer: ComposerTriggersConfig,
	projectControlled: boolean,
): ComposerTriggersConfig {
	if (!projectControlled) {
		const builtin = { ...(below?.builtin ?? {}), ...(layer.builtin ?? {}) }
		return {
			...(below ?? {}),
			...layer,
			...(Object.keys(builtin).length > 0 ? { builtin } : {}),
		}
	}
	const current = resolveComposerTriggers(below)
	const enabled = current.enabled && (layer.enabled ?? true)
	const suggest = current.suggest && (layer.suggest ?? true)
	const languages = layer.languages
		? current.languages.filter((language) => layer.languages?.includes(language))
		: undefined
	const builtin: Partial<Record<ComposerTriggerId, ComposerTriggerArming>> = {
		...(below?.builtin ?? {}),
	}
	for (const [id, arming] of Object.entries(layer.builtin ?? {}) as [
		ComposerTriggerId,
		ComposerTriggerArming,
	][]) {
		const now = current.arming[id]
		builtin[id] = RANK[arming] < RANK[now] ? arming : now
	}
	return {
		...(below ?? {}),
		...(layer.enabled !== undefined || below?.enabled !== undefined ? { enabled } : {}),
		...(layer.suggest !== undefined || below?.suggest !== undefined ? { suggest } : {}),
		...(languages !== undefined ? { languages } : {}),
		...(Object.keys(builtin).length > 0 ? { builtin } : {}),
	}
}

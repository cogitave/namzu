/**
 * What the `/skills` screen reads and writes: each skill's state, what its
 * one-line listing costs, and the save that puts a change in the project's
 * local settings file.
 *
 * A skill is `on`, `name-only` (the model is told its name but not its
 * description), `user-only` (the model is not told of it and cannot load it;
 * `/<name>` still works) or `off` (neither). The state comes from the config:
 * `skills.overrides[name]` first, else `off` when the name is in
 * `skills.disabled`, else `on`. The screen writes `skills.overrides` to
 * `.namzu/settings.local.json`, the layer that is this computer's and this
 * project's; a key whose value is what the weaker layers already give is
 * removed rather than written, so cycling a skill a full round leaves the file
 * as it was.
 */

import { readFileSync } from 'node:fs'

import { SKILL_OVERRIDE_STATES, type SkillOverride } from '../config/schema.js'
import { isTrusted } from '../integrations/trust/store.js'
import {
	LOCAL_SETTINGS_FILE,
	TRACKED_LOCAL_SETTINGS,
	ensureLocalConfigIgnored,
	localSettingsPath,
	localSettingsTracked,
	logIgnoreOutcome,
	moveLegacyLocalConfigOnce,
	updateLocalSettings,
} from '../permissions/local-settings.js'
import { CHARS_PER_TOKEN } from './catalog.js'
import type { SkillInfo } from './store.js'

export type SkillState = SkillOverride

/** The order Space cycles a skill through. */
export const SKILL_STATE_CYCLE: readonly SkillState[] = SKILL_OVERRIDE_STATES.map((state) => state)

/** The state after `state` when Space is pressed. */
export function nextSkillState(state: SkillState): SkillState {
	const index = SKILL_STATE_CYCLE.indexOf(state)
	return SKILL_STATE_CYCLE[(index + 1) % SKILL_STATE_CYCLE.length] as SkillState
}

/** The state the roster reports for a skill, with its config applied. */
export function skillStateOf(info: SkillInfo): SkillState {
	if (info.disabled === true) return 'off'
	return info.state ?? 'on'
}

/**
 * The state the layers under the project's local file give a skill: `off` when
 * the merged `skills.disabled` names it, else `on`, or the state a lower
 * layer's `skills.overrides` gives. A change that lands here is saved by
 * removing its override. `undefined` when the local file itself sets the name:
 * what lies beneath is then unknown, so a change is always written out.
 */
export function baseSkillState(
	name: string,
	disabled: readonly string[] | undefined,
	overrides?: Readonly<Record<string, SkillState>>,
	localKeys?: ReadonlySet<string>,
): SkillState | undefined {
	// A key the local file sets hides what the lower layers say, so it is not known here.
	if (localKeys?.has(name)) return undefined
	return overrides?.[name] ?? (disabled?.includes(name) ? 'off' : 'on')
}

/** The skill names the folder's local settings file gives a state; empty when it is missing or unreadable. */
export function localSkillOverrideKeys(cwd: string): ReadonlySet<string> {
	try {
		const document: unknown = JSON.parse(readFileSync(localSettingsPath(cwd), 'utf8'))
		const skills = isRecord(document) ? document.skills : undefined
		const overrides = isRecord(skills) ? skills.overrides : undefined
		return new Set(isRecord(overrides) ? Object.keys(overrides) : [])
	} catch {
		return new Set()
	}
}

/** What a skill's one-line entry costs the model each turn, in characters. */
export function skillListingChars(info: Pick<SkillInfo, 'name' | 'description'>): number {
	return info.name.length + info.description.length
}

/** The cost in tokens, an estimate from characters like the rest of the kernel's. */
export function skillListingTokens(info: Pick<SkillInfo, 'name' | 'description'>): number {
	return Math.round(skillListingChars(info) / CHARS_PER_TOKEN)
}

/** How a cost reads on a row: `< 20 tokens` under 20, else `~N tokens` to the nearest ten. */
export function formatTokenCost(tokens: number): string {
	if (tokens < 20) return '< 20 tokens'
	return `~${Math.round(tokens / 10) * 10} tokens`
}

export type SkillOverrideSave =
	| { readonly ok: true; readonly changed: number }
	| { readonly ok: false; readonly message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Write each change to `skills.overrides` in the folder's local settings file.
 * `null` takes a name's key out. Only the named keys are touched; the rest of
 * the file, and the other keys under `skills`, stay as they are.
 */
export function saveSkillOverrides(
	cwd: string,
	changes: Readonly<Record<string, SkillState | null>>,
	options: { readonly trusted?: boolean } = {},
): SkillOverrideSave {
	const names = Object.keys(changes)
	if (names.length === 0) return { ok: true, changed: 0 }
	if (!(options.trusted ?? isTrusted(cwd)))
		return {
			ok: false,
			message: 'this folder is not trusted, so nothing was saved to its settings',
		}
	moveLegacyLocalConfigOnce(cwd)
	if (localSettingsTracked(cwd, { fresh: true }))
		return { ok: false, message: TRACKED_LOCAL_SETTINGS }
	const write = updateLocalSettings(cwd, (document) => {
		if (document.skills !== undefined && !isRecord(document.skills))
			return { error: `${LOCAL_SETTINGS_FILE} has a skills value that is not a table` }
		const skills: Record<string, unknown> = isRecord(document.skills) ? { ...document.skills } : {}
		if (skills.overrides !== undefined && !isRecord(skills.overrides))
			return { error: `${LOCAL_SETTINGS_FILE} has a skills.overrides value that is not a table` }
		const overrides: Record<string, unknown> = isRecord(skills.overrides)
			? { ...skills.overrides }
			: {}
		for (const name of names) {
			const wanted = changes[name]
			if (wanted === null || wanted === undefined) delete overrides[name]
			else overrides[name] = wanted
		}
		if (Object.keys(overrides).length > 0) skills.overrides = overrides
		else skills.overrides = undefined
		const next: Record<string, unknown> = { ...document }
		if (Object.values(skills).some((value) => value !== undefined)) {
			next.skills = Object.fromEntries(
				Object.entries(skills).filter(([, value]) => value !== undefined),
			)
		} else {
			next.skills = undefined
		}
		return { document: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) }
	})
	if (write.error !== undefined) return { ok: false, message: write.error }
	void ensureLocalConfigIgnored(cwd).then(logIgnoreOutcome)
	return { ok: true, changed: names.length }
}

/**
 * What the list rows save, as pure functions: the folders Namzu may reach and the skills that are
 * turned off. A screen draws from these and saves what they return, so the value written is never
 * decided inside a click handler.
 */

import type { InstalledSkillView } from './config-lists-protocol.js'

/** The folders after one is picked: trimmed, and never twice. */
export function addFolder(items: readonly string[], picked: string): string[] {
	const path = picked.trim()
	if (path === '' || items.includes(path)) return [...items]
	return [...items, path]
}

export function withoutItem(items: readonly string[], item: string): string[] {
	return items.filter((other) => other !== item)
}

/**
 * The folders that are not there. `found` is what the check answered, or undefined while it has
 * not answered: nothing is called missing until it has.
 */
export function missingFolders(
	items: readonly string[],
	found: readonly string[] | undefined,
): ReadonlySet<string> {
	if (found === undefined) return new Set()
	return new Set(items.filter((item) => !found.includes(item)))
}

export interface SkillSwitchRows {
	/** Every installed skill, with whether it is turned on (not named in `skills.disabled`). */
	installed: { name: string; where: string; on: boolean }[]
	/** Names in the file that no installed skill has. */
	unknown: string[]
}

export function skillSwitchRows(
	installed: readonly InstalledSkillView[],
	disabled: unknown,
): SkillSwitchRows {
	const off = Array.isArray(disabled)
		? (disabled as unknown[]).filter((n): n is string => typeof n === 'string')
		: []
	return {
		installed: installed.map((skill) => ({
			name: skill.name,
			where: skill.where,
			on: !off.includes(skill.name),
		})),
		unknown: off.filter(
			(name, at) => !installed.some((s) => s.name === name) && off.indexOf(name) === at,
		),
	}
}

/**
 * The `skills.disabled` list after one switch moves: off adds the name, on takes it out. An empty
 * list is the default, so it comes back as `undefined` and the key is removed.
 */
export function skillsDisabledValue(
	disabled: unknown,
	name: string,
	on: boolean,
): string[] | undefined {
	const held = Array.isArray(disabled)
		? (disabled as unknown[]).filter((n): n is string => typeof n === 'string')
		: []
	const next = on
		? held.filter((other) => other !== name)
		: held.includes(name)
			? held
			: [...held, name]
	return next.length === 0 ? undefined : next
}

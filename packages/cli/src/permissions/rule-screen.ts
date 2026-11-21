/**
 * The rules `/permissions` shows and edits.
 *
 * Reading goes through each config file's own `permissions` table, one source
 * at a time, so a rule is always listed beside the file it came from. Adding
 * touches the project's local file only, `.namzu/settings.local.json`: it is
 * the one file Namzu already writes for a remembered answer, and Namzu keeps it
 * out of git. Removing takes the rule out of that file and out of
 * `namzu.config.local.json`, its earlier name, while that one is still read. A
 * rule that lives in another file is listed, and removing it means editing that
 * file.
 */

import { lstatSync } from 'node:fs'
import { basename } from 'node:path'

import type { PermissionLayer } from '../config/load.js'
import {
	LEGACY_LOCAL_CONFIG_FILE,
	LOCAL_SETTINGS_FILE,
	ensureLocalConfigIgnored,
	legacyLocalConfigPath,
	localSettingsPath,
	localSettingsTracked,
	logIgnoreOutcome,
	moveLegacyLocalConfigOnce,
	updateLocalSettings,
} from './local-settings.js'
import { ruleLooksSecret } from './rule-secrets.js'
import { foldRuleLists, parseRuleString, patternOf } from './rule-strings.js'
import { type PermissionEffect, isPermissionEffect } from './rules.js'

export interface RuleEntry {
	readonly effect: PermissionEffect
	/** The rule as it is written in a list: `Tool` or `Tool(specifier)`. */
	readonly rule: string
	/** A short name for the file, for the person. */
	readonly source: string
	/** Whether `/permissions remove` can take it out. */
	readonly removable: boolean
}

const SOURCE_NAMES: Record<PermissionLayer['source'], string> = {
	'user-file': 'your user settings',
	'project-file': 'this project',
	'local-file': 'this project, local',
	managed: 'managed settings',
}

function sourceName(layer: PermissionLayer): string {
	return layer.source === 'local-file' && basename(layer.path) === LEGACY_LOCAL_CONFIG_FILE
		? `this project, local (${LEGACY_LOCAL_CONFIG_FILE})`
		: SOURCE_NAMES[layer.source]
}

function ruleText(tool: string, pattern: string | undefined): string {
	return pattern === undefined || pattern === '*' ? tool : `${tool}(${pattern})`
}

/** Every rule of every layer, allow first, then ask, then deny. */
export function ruleEntries(layers: readonly PermissionLayer[]): RuleEntry[] {
	const out: RuleEntry[] = []
	for (const layer of layers) {
		for (const [tool, value] of Object.entries(layer.permissions)) {
			const base = { source: sourceName(layer), removable: layer.source === 'local-file' }
			if (typeof value === 'string') {
				out.push({ ...base, effect: value, rule: tool })
				continue
			}
			for (const [pattern, effect] of Object.entries(value)) {
				out.push({ ...base, effect, rule: ruleText(tool, pattern) })
			}
		}
	}
	const order: PermissionEffect[] = ['allow', 'ask', 'deny']
	return out.sort((a, b) => order.indexOf(a.effect) - order.indexOf(b.effect))
}

const TITLES: Record<PermissionEffect, string> = {
	allow: 'Allowed without asking',
	ask: 'Always asks',
	deny: 'Never allowed',
}

export function renderRules(entries: readonly RuleEntry[], only?: PermissionEffect): string {
	const lines: string[] = []
	for (const effect of ['allow', 'ask', 'deny'] as const) {
		if (only && effect !== only) continue
		const mine = entries.filter((e) => e.effect === effect)
		lines.push(`${TITLES[effect]} (${mine.length})`)
		if (mine.length === 0) lines.push('  None.')
		for (const e of mine) lines.push(`  ${e.rule}  (${e.source})`)
		lines.push('')
	}
	if (!only) {
		lines.push('Add one with /permissions add <allow|ask|deny> <rule>, for example')
		lines.push('/permissions add deny Bash(rm -rf *). Remove one with /permissions remove <rule>.')
		lines.push(
			`Both change ${LOCAL_SETTINGS_FILE} and update later calls in this conversation. Rules from other files are changed in those files.`,
		)
	}
	return lines.join('\n').trimEnd()
}

export interface RuleEdit {
	readonly ok: boolean
	readonly message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A permissions value that is not a table stops an edit, as it did before. */
function permissionsOf(
	document: Record<string, unknown>,
	name: string,
): { readonly permissions: Record<string, unknown> } | { readonly error: string } {
	if (document.permissions !== undefined && !isRecord(document.permissions))
		return { error: `${name} has a permissions value that is not a table.` }
	return { permissions: isRecord(document.permissions) ? { ...document.permissions } : {} }
}

/** Keep git from tracking the file; the edit was made either way. */
function keepIgnored(cwd: string): void {
	void ensureLocalConfigIgnored(cwd).then(logIgnoreOutcome)
}

export function addLocalRule(cwd: string, effect: PermissionEffect, rule: string): RuleEdit {
	const parsed = parseRuleString(rule)
	if (!parsed) {
		return {
			ok: false,
			message:
				'That is not a rule. Write a tool name, or a tool name with a specifier in parentheses, such as Bash(git status *).',
		}
	}
	if (ruleLooksSecret(parsed.tool, parsed.specifier)) {
		return {
			ok: false,
			message:
				'That rule looks like it holds a password or a token, so it was not saved. Write it without the secret, with a * in its place.',
		}
	}
	const { table, problem } = foldRuleLists({ [effect]: [rule] })
	if (problem) return { ok: false, message: problem.message }
	moveLegacyLocalConfigOnce(cwd)
	if (localSettingsTracked(cwd))
		return {
			ok: false,
			message: `Git tracks ${LOCAL_SETTINGS_FILE}, so the rule was not saved there. Take it out of git first (git rm --cached ${LOCAL_SETTINGS_FILE}).`,
		}
	const write = updateLocalSettings(cwd, (document) => {
		const read = permissionsOf(document, LOCAL_SETTINGS_FILE)
		if ('error' in read) return read
		const { permissions } = read
		for (const [tool, wanted] of Object.entries(table)) {
			const had = permissions[tool]
			if (typeof wanted === 'string') {
				if (isRecord(had)) permissions[tool] = { ...had, '*': wanted }
				else permissions[tool] = wanted
				continue
			}
			const patterns = isRecord(wanted) ? wanted : {}
			const base = isRecord(had) ? had : isPermissionEffect(had) ? { '*': had } : {}
			permissions[tool] = { ...base, ...patterns }
		}
		return { document: { ...document, permissions } }
	})
	if (write.error !== undefined) {
		return {
			ok: false,
			message: write.error.endsWith('.')
				? `Could not save the rule: ${write.error}`
				: `Could not save the rule: ${write.error}.`,
		}
	}
	keepIgnored(cwd)
	return {
		ok: true,
		message: `Added ${effect} rule ${rule} to ${LOCAL_SETTINGS_FILE}.`,
	}
}

/** Take `rule` out of one file's permissions; `removed` says whether it was there. */
function withoutRule(
	document: Record<string, unknown>,
	name: string,
	rule: string,
	parsed: NonNullable<ReturnType<typeof parseRuleString>>,
):
	| { readonly document: Record<string, unknown> }
	| { readonly unchanged: true }
	| { readonly error: string } {
	const read = permissionsOf(document, name)
	if ('error' in read) return read
	const { permissions } = read
	let removed = false
	const entry = permissions[parsed.tool]
	if (parsed.specifier === undefined) {
		if (isPermissionEffect(entry)) {
			delete permissions[parsed.tool]
			removed = true
		} else if (isRecord(entry) && entry['*'] !== undefined) {
			const { '*': _gone, ...rest } = entry
			if (Object.keys(rest).length === 0) delete permissions[parsed.tool]
			else permissions[parsed.tool] = rest
			removed = true
		}
	} else if (isRecord(entry)) {
		for (const effect of ['allow', 'ask', 'deny'] as const) {
			const key = patternOf(parsed.tool, parsed.specifier, effect)
			if (entry[key] === effect) {
				const { [key]: _gone, ...rest } = entry
				if (Object.keys(rest).length === 0) delete permissions[parsed.tool]
				else permissions[parsed.tool] = rest
				removed = true
				break
			}
		}
	}
	for (const list of ['allow', 'ask', 'deny'] as const) {
		const value = permissions[list]
		if (Array.isArray(value) && value.includes(rule)) {
			const kept = value.filter((item) => item !== rule)
			if (kept.length === 0) delete permissions[list]
			else permissions[list] = kept
			removed = true
		}
	}
	if (!removed) return { unchanged: true }
	const out: Record<string, unknown> = { ...document, permissions }
	if (Object.keys(permissions).length === 0) out.permissions = undefined
	return { document: out }
}

export function removeLocalRule(cwd: string, rule: string): RuleEdit {
	const parsed = parseRuleString(rule)
	if (!parsed) return { ok: false, message: `That is not a rule: ${rule}` }
	moveLegacyLocalConfigOnce(cwd)
	const from: string[] = []
	// The earlier file too, while it is still read: a rule left there would still decide.
	for (const [target, name, path] of [
		['current', LOCAL_SETTINGS_FILE, localSettingsPath(cwd)],
		['legacy', LEGACY_LOCAL_CONFIG_FILE, legacyLocalConfigPath(cwd)],
	] as const) {
		if (!isFile(path)) continue
		let removed = false
		const write = updateLocalSettings(
			cwd,
			(document) => {
				const result = withoutRule(document, name, rule, parsed)
				if ('document' in result) removed = true
				return result
			},
			{ target },
		)
		if (write.error !== undefined) {
			return {
				ok: false,
				message: write.error.endsWith('.')
					? `Could not save the change: ${write.error}`
					: `Could not save the change: ${write.error}.`,
			}
		}
		if (removed) from.push(name)
	}
	if (from.length === 0) {
		const where = isFile(legacyLocalConfigPath(cwd))
			? `${LOCAL_SETTINGS_FILE} or ${LEGACY_LOCAL_CONFIG_FILE}`
			: LOCAL_SETTINGS_FILE
		return {
			ok: false,
			message: `No rule ${rule} in ${where}. Rules from other files are removed by editing those files (see /permissions rules).`,
		}
	}
	keepIgnored(cwd)
	return {
		ok: true,
		message: `Removed ${rule} from ${from.join(' and ')}.`,
	}
}

/** A file there, or a link: a link is refused by the writer with its reason. */
function isFile(path: string): boolean {
	try {
		const info = lstatSync(path)
		return info.isFile() || info.isSymbolicLink()
	} catch {
		return false
	}
}

export interface DenialRow {
	readonly tool: string
	readonly summary: string
	readonly reason: string
}

export function renderRecentDenials(rows: readonly DenialRow[] | undefined): string {
	if (!rows || rows.length === 0) {
		return 'No recent denials. Calls refused by auto mode will be listed here.'
	}
	const lines = [`Recently refused by auto mode (${rows.length}, newest first)`]
	for (const row of rows) {
		lines.push(`  ${row.tool}${row.summary ? `: ${row.summary}` : ''}`)
		lines.push(`    ${row.reason}`)
	}
	return lines.join('\n')
}

/**
 * The rules `/permissions` shows and edits.
 *
 * Reading goes through each config file's own `permissions` table, one source
 * at a time, so a rule is always listed beside the file it came from. Adding
 * and removing touch the project's local file only: it is the one file Namzu
 * already writes for a remembered answer, and git does not track it. A rule
 * that lives in another file is listed, and removing it means editing that file.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import type { PermissionLayer } from '../config/load.js'
import { LOCAL_CONFIG_FILE, localConfigPath } from './local-settings.js'
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

function ruleText(tool: string, pattern: string | undefined): string {
	return pattern === undefined || pattern === '*' ? tool : `${tool}(${pattern})`
}

/** Every rule of every layer, allow first, then ask, then deny. */
export function ruleEntries(layers: readonly PermissionLayer[]): RuleEntry[] {
	const out: RuleEntry[] = []
	for (const layer of layers) {
		for (const [tool, value] of Object.entries(layer.permissions)) {
			const base = { source: SOURCE_NAMES[layer.source], removable: layer.source === 'local-file' }
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
			`Both change ${LOCAL_CONFIG_FILE} and update later calls in this conversation. Rules from other files are changed in those files.`,
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

function readLocal(cwd: string): { document: Record<string, unknown> } | { error: string } {
	const path = localConfigPath(cwd)
	if (!existsSync(path)) return { document: {} }
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(path, 'utf-8'))
	} catch {
		return { error: `${LOCAL_CONFIG_FILE} is not valid JSON, so it was left alone.` }
	}
	if (!isRecord(parsed)) return { error: `${LOCAL_CONFIG_FILE} is not a JSON object.` }
	if (parsed.permissions !== undefined && !isRecord(parsed.permissions)) {
		return { error: `${LOCAL_CONFIG_FILE} has a permissions value that is not a table.` }
	}
	return { document: parsed }
}

function save(cwd: string, document: Record<string, unknown>): string | undefined {
	const path = localConfigPath(cwd)
	try {
		const staging = `${path}.${process.pid}.tmp`
		writeFileSync(staging, `${JSON.stringify(document, null, '\t')}\n`, { mode: 0o600 })
		renameSync(staging, path)
		return undefined
	} catch (cause) {
		return cause instanceof Error ? cause.message : String(cause)
	}
}

export function addLocalRule(cwd: string, effect: PermissionEffect, rule: string): RuleEdit {
	if (!parseRuleString(rule)) {
		return {
			ok: false,
			message:
				'That is not a rule. Write a tool name, or a tool name with a specifier in parentheses, such as Bash(git status *).',
		}
	}
	const read = readLocal(cwd)
	if ('error' in read) return { ok: false, message: read.error }
	const permissions: Record<string, unknown> = isRecord(read.document.permissions)
		? { ...read.document.permissions }
		: {}
	const { table, problem } = foldRuleLists({ [effect]: [rule] })
	if (problem) return { ok: false, message: problem.message }
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
	const failed = save(cwd, { ...read.document, permissions })
	if (failed) return { ok: false, message: `Could not save the rule: ${failed}` }
	return {
		ok: true,
		message: `Added ${effect} rule ${rule} to ${LOCAL_CONFIG_FILE}.`,
	}
}

export function removeLocalRule(cwd: string, rule: string): RuleEdit {
	const parsed = parseRuleString(rule)
	if (!parsed) return { ok: false, message: `That is not a rule: ${rule}` }
	const read = readLocal(cwd)
	if ('error' in read) return { ok: false, message: read.error }
	const permissions: Record<string, unknown> = isRecord(read.document.permissions)
		? { ...read.document.permissions }
		: {}
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
	if (!removed) {
		return {
			ok: false,
			message: `No rule ${rule} in ${LOCAL_CONFIG_FILE}. Rules from other files are removed by editing those files (see /permissions rules).`,
		}
	}
	const document = { ...read.document, permissions }
	if (Object.keys(permissions).length === 0) {
		;(document as Record<string, unknown>).permissions = undefined
	}
	const failed = save(cwd, document)
	if (failed) return { ok: false, message: `Could not save the change: ${failed}` }
	return {
		ok: true,
		message: `Removed ${rule} from ${LOCAL_CONFIG_FILE}.`,
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

/**
 * What each skill has been loaded for, kept in one small file beside the other
 * per-user state: `<home>/skill-usage.json`.
 *
 * It is the whole record behind the Uses, Last used and 7d tokens figures of
 * the plugin screen, and nothing else reads it. A load adds one to the count,
 * stamps the time and keeps the size of what was loaded (as tokens, at the
 * same characters-per-token the listing uses) for seven days. Loads of the
 * same skill within a minute of each other count once, so a skill read page by
 * page, or twice by a retry, is one use.
 *
 * Nothing here is allowed to break a turn: a file that is missing, unreadable
 * or not what this code writes reads as empty, and a failed write is dropped.
 * The file is replaced whole through a temporary name, so a reader sees the
 * old record or the new one.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveNamzuHome } from '../integrations/state/home.js'

/** Loads closer together than this are one use. */
export const USE_THROTTLE_MS = 60_000
/** How long a load's size is kept for the 7-day figure. */
export const TOKEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Characters per token, the one figure the listing estimates with. */
const CHARS_PER_TOKEN = 4

export interface SkillUse {
	readonly count: number
	readonly lastUsedAt: number
	/** The size of each load in the last seven days. */
	readonly loads: readonly { readonly at: number; readonly tokens: number }[]
}

export interface SkillUsage {
	/** When this file started counting: earlier loads are not in it. */
	readonly since: number
	readonly skills: Readonly<Record<string, SkillUse>>
}

export function skillUsagePath(home: string = resolveNamzuHome()): string {
	return join(home, 'skill-usage.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function parseUse(value: unknown): SkillUse | undefined {
	if (!isRecord(value) || !finite(value.count) || !finite(value.lastUsedAt)) return undefined
	const loads = Array.isArray(value.loads)
		? value.loads.flatMap((load): { at: number; tokens: number }[] =>
				isRecord(load) && finite(load.at) && finite(load.tokens)
					? [{ at: load.at, tokens: load.tokens }]
					: [],
			)
		: []
	return { count: value.count, lastUsedAt: value.lastUsedAt, loads }
}

/** The record as it stands; an empty one, starting `now`, when there is none to read. */
export function readSkillUsage(home?: string, now: number = Date.now()): SkillUsage {
	try {
		const parsed: unknown = JSON.parse(readFileSync(skillUsagePath(home), 'utf8'))
		if (isRecord(parsed) && parsed.v === 1 && finite(parsed.since) && isRecord(parsed.skills)) {
			const skills: Record<string, SkillUse> = {}
			for (const [name, value] of Object.entries(parsed.skills)) {
				const use = parseUse(value)
				if (use) skills[name] = use
			}
			return { since: parsed.since, skills }
		}
	} catch {
		// Missing or unreadable: nothing recorded yet.
	}
	return { since: now, skills: {} }
}

/** The tokens a skill's text adds to the conversation when it loads. */
export function skillBodyTokens(chars: number): number {
	return Math.max(1, Math.round(chars / CHARS_PER_TOKEN))
}

/**
 * Count one load of `name`. Returns whether the file changed. Best effort:
 * every failure is swallowed, because a usage figure is never worth a turn.
 */
export function recordSkillUse(
	name: string,
	chars: number,
	options: { readonly home?: string; readonly now?: number } = {},
): boolean {
	const now = options.now ?? Date.now()
	try {
		const usage = readSkillUsage(options.home, now)
		const before = usage.skills[name]
		if (before && now - before.lastUsedAt >= 0 && now - before.lastUsedAt < USE_THROTTLE_MS) {
			return false
		}
		const loads = [
			...(before?.loads ?? []).filter((load) => now - load.at < TOKEN_WINDOW_MS),
			{ at: now, tokens: skillBodyTokens(chars) },
		]
		const next = {
			v: 1,
			since: usage.since,
			skills: {
				...usage.skills,
				[name]: { count: (before?.count ?? 0) + 1, lastUsedAt: now, loads },
			},
		}
		const path = skillUsagePath(options.home)
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
		const temp = `${path}.${randomUUID()}.tmp`
		try {
			writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 })
			renameSync(temp, path)
		} catch (error) {
			rmSync(temp, { force: true })
			throw error
		}
		return true
	} catch {
		return false
	}
}

/** Tokens the skill's loads added in the seven days up to `now`; `undefined` when none. */
export function sevenDayTokens(use: SkillUse | undefined, now: number): number | undefined {
	const total = (use?.loads ?? [])
		.filter((load) => now - load.at < TOKEN_WINDOW_MS)
		.reduce((sum, load) => sum + load.tokens, 0)
	return total > 0 ? total : undefined
}

const DAY_MS = 24 * 60 * 60 * 1000

/** `today`, `3d`, or `never` for a skill with no use. */
export function ageWord(use: SkillUse | undefined, now: number): string {
	if (!use || use.count === 0) return 'never'
	const days = Math.floor(Math.max(0, now - use.lastUsedAt) / DAY_MS)
	return days === 0 ? 'today' : `${days}d`
}

/** The row words for Installed: `3× 2d`, `1× today`, `never used`. */
export function usageWords(use: SkillUse | undefined, now: number): string {
	if (!use || use.count === 0) return 'never used'
	return `${use.count}× ${ageWord(use, now)}`
}

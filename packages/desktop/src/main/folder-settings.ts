import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Settings a folder can carry that run code, or widen what may run, once the folder is
 * trusted: no model request is needed. Detection only looks at names and counts. It reads
 * one small file and lists two directories; it never runs, imports or follows anything.
 */

export const CONFIG_FILE = 'namzu.config.json'
export const CONFIG_LIMIT = 1024 * 1024
export const ENTRY_CAP = 2000

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`
}

/** What one finding holds, for the dialog's "Details": a few short lines, secrets removed. */
export interface AutoRunFinding {
	/** Plain words for the list: what was found and why it matters. */
	label: string
	/** The actual commands, servers or names behind it; empty when there is nothing more to show. */
	lines: string[]
}

const LINE_CAP = 8
const LINE_LENGTH = 240
const SECRET_NAME = /(token|secret|password|passwd|apikey|api[-_]key|auth|bearer|credential)/i

/** Keeps a line short and one line, and drops anything that looks like a credential or a URL's query. */
export function safeLine(text: string): string {
	const cleaned = text
		.replace(/\s+/g, ' ')
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1')
		.replace(/(\bhttps?:\/\/[^\s?#]*)[?#]\S*/gi, '$1')
		.replace(/(--?[\w-]+[=:]|\b[\w.-]+=)(\S+)/g, (match, name: string) =>
			SECRET_NAME.test(name) ? `${name}…` : match,
		)
		.replace(/(\b(?:bearer|token|authorization)\s+)\S+/gi, '$1…')
		.trim()
	return cleaned.length > LINE_LENGTH ? `${cleaned.slice(0, LINE_LENGTH - 1)}…` : cleaned
}

function capped(lines: string[], total = lines.length): string[] {
	const shown = lines.slice(0, LINE_CAP).map(safeLine)
	return total > shown.length ? [...shown, `…and ${total - shown.length} more`] : shown
}

function entries(value: unknown): [string, unknown][] {
	if (Array.isArray(value)) return value.map((item, index) => [String(index + 1), item])
	return value && typeof value === 'object' ? Object.entries(value) : []
}

function scalar(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value)
}

function hookLines(value: unknown): string[] {
	const lines: string[] = []
	for (const [event, list] of entries(value))
		for (const [, hook] of entries(Array.isArray(list) ? list : [list])) {
			const command =
				hook && typeof hook === 'object' ? (hook as { command?: unknown }).command : hook
			lines.push(
				`${event.replace(/_/g, ' ')}: ${typeof command === 'string' ? command : scalar(hook)}`,
			)
		}
	return capped(lines)
}

function serverLines(value: unknown): string[] {
	const lines = entries(value).map(([name, server]) => {
		const def = (server && typeof server === 'object' ? server : {}) as Record<string, unknown>
		const args = Array.isArray(def.args) ? def.args.map(String).join(' ') : ''
		const how =
			typeof def.command === 'string'
				? `${def.command} ${args}`
				: typeof def.url === 'string'
					? def.url
					: typeof server === 'string'
						? server
						: 'no command or address given'
		return `${name}: ${how.trim()}`
	})
	return capped(lines)
}

function settingLines(value: unknown): string[] {
	if (Array.isArray(value)) return capped(value.map(scalar), value.length)
	const all = entries(value).map(([key, item]) => {
		const shown =
			item && typeof item === 'object'
				? Array.isArray(item)
					? `${item.length} listed`
					: `${Object.keys(item).length} settings`
				: scalar(item)
		return SECRET_NAME.test(key) ? `${key}: …` : `${key}: ${shown}`
	})
	return capped(all)
}

/** Config sections that execute or widen what may run, with how each reads in the dialog. */
export const CONFIG_SECTIONS: readonly [key: string, say: (value: unknown) => AutoRunFinding][] = [
	[
		'hooks',
		(value) => ({
			label: 'commands that run by themselves at set moments (hooks)',
			lines: hookLines(value),
		}),
	],
	[
		'mcpServers',
		(value) => {
			const count =
				value && typeof value === 'object'
					? Array.isArray(value)
						? value.length
						: Object.keys(value).length
					: 1
			return {
				label:
					count === 1
						? '1 tool it can start (an MCP server)'
						: `${count} tools it can start (MCP servers)`,
				lines: serverLines(value),
			}
		},
	],
	[
		'plugins',
		(value) => ({ label: 'plugins that add their own code', lines: settingLines(value) }),
	],
	[
		'permissions',
		(value) => ({
			label: 'its own rules for what Namzu may do without asking',
			lines: settingLines(value),
		}),
	],
	[
		'permissionChecks',
		(value) => ({ label: 'changes to how actions are checked', lines: settingLines(value) }),
	],
	[
		'sandbox',
		(value) => ({
			label: 'settings that can change how commands are isolated',
			lines: settingLines(value),
		}),
	],
	[
		'web',
		(value) => ({
			label: 'settings for what Namzu may fetch from the web',
			lines: settingLines(value),
		}),
	],
	[
		'additionalDirectories',
		(value) => ({ label: 'extra folders Namzu may reach', lines: settingLines(value) }),
	],
	[
		'profiles',
		(value) => ({ label: 'saved profiles that change those settings', lines: settingLines(value) }),
	],
]

/**
 * A link (symbolic link or Windows junction) is reported as such, never followed: the CLI
 * reads through links, so a link in a settings position can point anywhere and is treated
 * as carrying settings.
 */
export async function entryKind(path: string): Promise<'file' | 'directory' | 'link' | undefined> {
	try {
		const info = await lstat(path)
		if (info.isSymbolicLink()) return 'link'
		return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
	} catch {
		return undefined
	}
}

async function countEntries(directory: string): Promise<number> {
	try {
		return Math.min((await readdir(directory)).length, ENTRY_CAP)
	} catch {
		return 0
	}
}

async function entryNames(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory)).sort().slice(0, ENTRY_CAP)
	} catch {
		return []
	}
}

/** What was found, in a stable order, each with the lines behind it; empty when the folder is ordinary. */
export async function inspectAutoRunSettings(folder: string): Promise<AutoRunFinding[]> {
	const found: AutoRunFinding[] = []
	const config = join(folder, CONFIG_FILE)
	const configKind = await entryKind(config)
	if (configKind === 'link')
		found.push({
			label: `a Namzu settings file that is a shortcut to somewhere else (${CONFIG_FILE})`,
			lines: [],
		})
	if (configKind === 'file') {
		try {
			const text = await readFile(config, 'utf8')
			if (text.length > CONFIG_LIMIT) throw new Error('too large')
			const parsed: unknown = JSON.parse(text)
			const sections: AutoRunFinding[] = []
			if (parsed && typeof parsed === 'object') {
				for (const [key, say] of CONFIG_SECTIONS) {
					const value = (parsed as Record<string, unknown>)[key]
					if (value === undefined || value === null) continue
					if (typeof value === 'object' && Object.keys(value as object).length === 0) continue
					sections.push(say(value))
				}
			}
			if (sections.length > 0)
				found.push(
					{ label: `a Namzu settings file that can start programs (${CONFIG_FILE})`, lines: [] },
					...sections,
				)
		} catch {
			// Present but unreadable: it may still be read as settings later, so say so.
			found.push({
				label: `a Namzu settings file that could not be read (${CONFIG_FILE})`,
				lines: [],
			})
		}
	}
	const state = join(folder, '.namzu')
	if ((await entryKind(state)) === 'link') {
		found.push({ label: 'a .namzu folder that is a shortcut to somewhere else', lines: [] })
		return found
	}
	for (const [name, one, many] of [
		['plugins', 'plugin', 'plugins'],
		['commands', 'command', 'commands'],
	] as const) {
		const where = join(state, name)
		const kind = await entryKind(where)
		if (kind === 'link')
			found.push({
				label: `a .namzu/${name} folder that is a shortcut to somewhere else`,
				lines: [],
			})
		else if (kind === 'directory') {
			const count = await countEntries(where)
			if (count)
				found.push({
					label: `${plural(count, one, many)} in .namzu/${name}`,
					lines: capped(await entryNames(where), count),
				})
		}
	}
	return found
}

/** Short phrases naming what was found, in a stable order; empty when the folder is ordinary. */
export async function findAutoRunSettings(folder: string): Promise<string[]> {
	return (await inspectAutoRunSettings(folder)).map((item) => item.label)
}

import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Settings a folder can carry that run code, or widen what may run, once the folder is
 * trusted: no model request is needed. Detection only looks at names and counts. It reads
 * one small file and lists two directories; it never runs, imports or follows anything.
 */

const CONFIG_FILE = 'namzu.config.json'
const CONFIG_LIMIT = 1024 * 1024
const ENTRY_CAP = 2000

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`
}

/** Config sections that execute or widen what may run, with how each reads in the dialog. */
const CONFIG_SECTIONS: readonly [key: string, say: (value: unknown) => string][] = [
	['hooks', () => 'hooks'],
	[
		'mcpServers',
		(value) => {
			const count =
				value && typeof value === 'object'
					? Array.isArray(value)
						? value.length
						: Object.keys(value).length
					: 1
			return plural(count, 'MCP server', 'MCP servers')
		},
	],
	['plugins', () => 'plugins'],
	['permissions', () => 'permission rules'],
	['permissionChecks', () => 'permission checks'],
	['sandbox', () => 'sandbox settings'],
	['web', () => 'web settings'],
	['additionalDirectories', () => 'extra directories'],
	['profiles', () => 'profiles'],
]

/**
 * A link (symbolic link or Windows junction) is reported as such, never followed: the CLI
 * reads through links, so a link in a settings position can point anywhere and is treated
 * as carrying settings.
 */
async function entryKind(path: string): Promise<'file' | 'directory' | 'link' | undefined> {
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

/** Short phrases naming what was found, in a stable order; empty when the folder is ordinary. */
export async function findAutoRunSettings(folder: string): Promise<string[]> {
	const found: string[] = []
	const config = join(folder, CONFIG_FILE)
	const configKind = await entryKind(config)
	if (configKind === 'link') found.push(`${CONFIG_FILE} that is a link`)
	if (configKind === 'file') {
		try {
			const text = await readFile(config, 'utf8')
			if (text.length > CONFIG_LIMIT) throw new Error('too large')
			const parsed: unknown = JSON.parse(text)
			if (parsed && typeof parsed === 'object') {
				for (const [key, say] of CONFIG_SECTIONS) {
					const value = (parsed as Record<string, unknown>)[key]
					if (value === undefined || value === null) continue
					if (typeof value === 'object' && Object.keys(value as object).length === 0) continue
					found.push(say(value))
				}
			}
		} catch {
			// Present but unreadable: it may still be read as settings later, so say so.
			found.push(`${CONFIG_FILE} that could not be read`)
		}
	}
	const state = join(folder, '.namzu')
	if ((await entryKind(state)) === 'link') {
		found.push('.namzu that is a link')
		return found
	}
	for (const [name, one, many] of [
		['plugins', 'plugin', 'plugins'],
		['commands', 'command', 'commands'],
	] as const) {
		const where = join(state, name)
		const kind = await entryKind(where)
		if (kind === 'link') found.push(`.namzu/${name} that is a link`)
		else if (kind === 'directory') {
			const count = await countEntries(where)
			if (count) found.push(`${plural(count, one, many)} in .namzu/${name}`)
		}
	}
	return found
}

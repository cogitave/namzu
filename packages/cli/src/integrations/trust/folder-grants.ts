/**
 * What a folder's own config pre-approves, read for the trust prompt.
 *
 * The gate asks before the folder's config is applied, so this reads the two
 * project files straight from disk and never validates or merges them: a file
 * that cannot be read or is not an object grants nothing here, and the real
 * load reports it once the folder is trusted. Only what the person needs to
 * weigh the choice is returned: the allow rules, the extra directories and
 * the names of the tool servers the shared file declares.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { PROJECT_MCP_FILE, parseMcpServerFile } from '../mcp/shared-file.js'

const FILES = ['namzu.config.json', 'namzu.config.local.json'] as const

/** Rules shown before the rest are counted. */
export const MAX_SHOWN_GRANT_RULES = 8

export interface FolderGrants {
	/** Allow rules in the order written, `tool` or `tool(pattern)`, each once. */
	readonly allowRules: readonly string[]
	/** Extra directories the folder adds to the workspace, as written, each once. */
	readonly directories: readonly string[]
	/** Tool servers the folder's shared file declares; approving the folder approves these. */
	readonly toolServers: readonly string[]
}

function readObject(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

/** The allow rules and added directories the folder's own config carries. */
export function readFolderGrants(cwd: string): FolderGrants {
	const allowRules: string[] = []
	const directories: string[] = []
	for (const file of FILES) {
		const config = readObject(resolve(cwd, file))
		if (!config) continue
		const permissions = config.permissions
		if (permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions)) {
			for (const [tool, value] of Object.entries(permissions)) {
				if (value === 'allow') allowRules.push(tool)
				else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
					for (const [pattern, effect] of Object.entries(value)) {
						if (effect === 'allow') allowRules.push(`${tool}(${pattern})`)
					}
				}
			}
		}
		if (Array.isArray(config.additionalDirectories)) {
			for (const dir of config.additionalDirectories) {
				if (typeof dir === 'string' && dir.length > 0) directories.push(dir)
			}
		}
	}
	let toolServers: string[] = []
	try {
		toolServers = Object.keys(
			parseMcpServerFile(readFileSync(resolve(cwd, PROJECT_MCP_FILE), 'utf8'), PROJECT_MCP_FILE),
		)
	} catch {
		// Absent or unreadable: the real load reports it once the folder is trusted.
	}
	return {
		allowRules: [...new Set(allowRules)],
		directories: [...new Set(directories)],
		toolServers,
	}
}

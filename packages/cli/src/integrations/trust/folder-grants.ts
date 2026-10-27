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

import { fingerprintMcpServer } from '../mcp/project-approval.js'
import { PROJECT_MCP_FILE, parseMcpServerFile } from '../mcp/shared-file.js'

const FILES = ['namzu.config.json', 'namzu.config.local.json'] as const

/** Rules shown before the rest are counted. */
export const MAX_SHOWN_GRANT_RULES = 8

/** One tool server the shared file declares, as the trust screen shows it. */
export interface ToolServerGrant {
	readonly name: string
	/** What starting it runs or reaches: the command and arguments, or the address. Never env or headers. */
	readonly runs: string
	/** Taken when the screen is built; accepting the folder approves exactly this entry. */
	readonly fingerprint: string
}

export interface FolderGrants {
	/** Allow rules in the order written, `tool` or `tool(pattern)`, each once. */
	readonly allowRules: readonly string[]
	/** Extra directories the folder adds to the workspace, as written, each once. */
	readonly directories: readonly string[]
	/** Tool servers the folder's shared file declares; approving the folder approves these. */
	readonly toolServers: readonly ToolServerGrant[]
}

/** The address without credentials or a query, which can carry a token. */
function plainAddress(url: string): string {
	try {
		const parsed = new URL(url)
		return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
	} catch {
		return url.split(/[?#]/)[0] ?? url
	}
}

/** Say what an entry would start or reach, in the words of the file. */
function describeRuns(entry: unknown): string {
	if (entry === null || typeof entry !== 'object') return 'unknown'
	const spec = entry as { command?: unknown; args?: unknown; url?: unknown }
	if (typeof spec.command === 'string' && spec.command.length > 0) {
		const args = Array.isArray(spec.args)
			? spec.args.filter((arg): arg is string => typeof arg === 'string')
			: []
		return [spec.command, ...args].join(' ').replace(/\s+/g, ' ')
	}
	if (typeof spec.url === 'string' && spec.url.length > 0) return plainAddress(spec.url)
	return 'unknown'
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
	let toolServers: ToolServerGrant[] = []
	try {
		const declared = parseMcpServerFile(
			readFileSync(resolve(cwd, PROJECT_MCP_FILE), 'utf8'),
			PROJECT_MCP_FILE,
		)
		toolServers = Object.entries(declared).map(([name, entry]) => ({
			name,
			runs: describeRuns(entry),
			fingerprint: fingerprintMcpServer(entry),
		}))
	} catch {
		// Absent or unreadable: the real load reports it once the folder is trusted.
	}
	return {
		allowRules: [...new Set(allowRules)],
		directories: [...new Set(directories)],
		toolServers,
	}
}

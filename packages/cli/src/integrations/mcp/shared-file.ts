/**
 * Tool servers written in a JSON file other than the Namzu config.
 *
 * Two places read the same shape, `{ "mcpServers": { "<name>": { ... } } }`:
 *
 * - `.mcp.json` at the root of a project, so a team shares its servers by
 *   committing one file. It is read exactly when `namzu.config.json` is, which
 *   is after the person has trusted the folder: until then no server in it is
 *   read, let alone started, and trust is the person's approval.
 * - a file named on the command line (`namzu exec --mcp-config <file>`), which
 *   the person chose for this one run.
 *
 * Entries are the ones `mcpServers` takes. A `type` key that other tools write
 * (`stdio`, `http`) is accepted and ignored, because the entry's `command` or
 * `url` already says which it is. Nothing else is rewritten: a `${VAR}` form
 * this reader does not expand stays literal, as it does in the config.
 */

import { readFileSync } from 'node:fs'

import type { McpServersConfig } from './servers.js'

/** The file at a project's root. */
export const PROJECT_MCP_FILE = '.mcp.json'

/** Why a server file could not be read, in words for the person who named it. */
export class McpServerFileError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'McpServerFileError'
	}
}

/** Read `raw` (the contents of `label`) as a table of tool servers. */
export function parseMcpServerFile(raw: string, label: string): McpServersConfig {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new McpServerFileError(`${label} isn't valid JSON. Fix it, then start Namzu again.`)
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new McpServerFileError(`${label} must be a JSON object with an "mcpServers" table.`)
	}
	const table = (parsed as Record<string, unknown>).mcpServers
	if (table === undefined) return {}
	if (table === null || typeof table !== 'object' || Array.isArray(table)) {
		throw new McpServerFileError(`${label}: "mcpServers" must be a table of server names.`)
	}
	const servers: Record<string, unknown> = {}
	for (const [name, entry] of Object.entries(table)) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new McpServerFileError(`${label}: the server "${name}" must be an object.`)
		}
		const { type: _type, ...rest } = entry as Record<string, unknown>
		servers[name] = rest
	}
	return servers as McpServersConfig
}

/** Read a server file from disk. `undefined` when it does not exist. */
export function readMcpServerFile(path: string, label: string): McpServersConfig | undefined {
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw new McpServerFileError(`${label} could not be read.`)
	}
	return parseMcpServerFile(raw, label)
}

/**
 * The servers a launch adds: each `--mcp-config` file in order, a later file
 * replacing an earlier server of the same name, all of it replacing a server
 * of the same name from the config. A file that is missing is an error here,
 * unlike the project file, because the person named it.
 */
export function mergeLaunchMcpServers(
	configured: McpServersConfig | undefined,
	files: readonly string[],
	resolvePath: (path: string) => string,
): McpServersConfig | undefined {
	if (files.length === 0) return configured
	let merged: Record<string, unknown> = { ...configured }
	for (const file of files) {
		const absolute = resolvePath(file)
		const found = readMcpServerFile(absolute, `--mcp-config ${file}`)
		if (found === undefined) {
			throw new McpServerFileError(`--mcp-config ${file}: no such file.`)
		}
		merged = { ...merged, ...found }
	}
	return merged as McpServersConfig
}

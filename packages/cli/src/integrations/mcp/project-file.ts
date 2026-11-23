/**
 * Writing the project's `.mcp.json`: `namzu mcp add --scope project` and
 * `namzu mcp remove --scope project`.
 *
 * The file is the shared one {@link PROJECT_MCP_FILE} names. Only the one entry changes: every
 * other key in the file stays as it was, and an entry already there is never replaced. A server
 * written here does not start until the person approves it (`namzu mcp approve`), the same as
 * one a teammate committed.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PROJECT_MCP_FILE } from './shared-file.js'

function readTable(path: string): {
	whole: Record<string, unknown>
	table: Record<string, unknown>
} {
	if (!existsSync(path)) return { whole: {}, table: {} }
	let whole: unknown
	try {
		whole = JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		throw new Error(`${PROJECT_MCP_FILE} is not valid JSON; fix it first.`)
	}
	if (whole === null || typeof whole !== 'object' || Array.isArray(whole)) {
		throw new Error(`${PROJECT_MCP_FILE} must be a JSON object with an "mcpServers" table.`)
	}
	const table = (whole as Record<string, unknown>).mcpServers
	if (table === undefined) return { whole: whole as Record<string, unknown>, table: {} }
	if (table === null || typeof table !== 'object' || Array.isArray(table)) {
		throw new Error(`${PROJECT_MCP_FILE}: "mcpServers" must be a table of server names.`)
	}
	return { whole: whole as Record<string, unknown>, table: table as Record<string, unknown> }
}

function write(path: string, whole: Record<string, unknown>, table: Record<string, unknown>): void {
	const temporary = `${path}.${process.pid}.tmp`
	writeFileSync(temporary, `${JSON.stringify({ ...whole, mcpServers: table }, null, 2)}\n`)
	renameSync(temporary, path)
}

/** The names `.mcp.json` in `cwd` declares. */
export function projectMcpServerNames(cwd: string): readonly string[] {
	return Object.keys(readTable(join(cwd, PROJECT_MCP_FILE)).table)
}

/** Add one entry; refuses a name the file already has. Returns the file's path. */
export function addProjectMcpServer(cwd: string, name: string, spec: unknown): string {
	const path = join(cwd, PROJECT_MCP_FILE)
	const { whole, table } = readTable(path)
	if (Object.hasOwn(table, name)) throw new Error(`server "${name}" already exists in ${path}`)
	write(path, whole, { ...table, [name]: spec })
	return path
}

/** Remove one entry. False when the file does not have it. */
export function removeProjectMcpServer(cwd: string, name: string): boolean {
	const path = join(cwd, PROJECT_MCP_FILE)
	const { whole, table } = readTable(path)
	if (!Object.hasOwn(table, name)) return false
	const { [name]: _removed, ...rest } = table
	write(path, whole, rest)
	return true
}

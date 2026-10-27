/**
 * The person's answer for each tool server a project's `.mcp.json` declares.
 *
 * A trusted folder is not a reviewed server list: `.mcp.json` is a file other
 * tools write into repositories, and a pull can change it. So a server from it
 * starts only after the person approved that server in that folder, and the
 * approval is for what the entry said at the time. The entry's command or url,
 * its arguments, environment and headers are fingerprinted together; an entry
 * that changes is pending again.
 *
 * Kept in `<namzu home>/mcp-approvals.json`, beside the folder-trust list:
 * `{ "version": 1, "folders": { "<folder>": { "<server>": "<fingerprint>" } } }`.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { canonicalProjectPath } from '../../permissions/canonical-project.js'
import type { McpServersConfig } from './servers.js'

const FILE_VERSION = 1

interface ApprovalFile {
	readonly version: number
	readonly folders: Record<string, Record<string, string>>
}

export function mcpApprovalsPath(namzuHome: string): string {
	return join(namzuHome, 'mcp-approvals.json')
}

function folderKey(cwd: string): string {
	try {
		return canonicalProjectPath(cwd)
	} catch {
		return resolve(cwd)
	}
}

/** Keys sorted at every depth, so the same entry always hashes the same. */
function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable)
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, inner]) => [key, stable(inner)]),
		)
	}
	return value
}

/** What an approval is bound to: the whole entry, so any change asks again. */
export function fingerprintMcpServer(entry: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(stable(entry)) ?? 'null')
		.digest('hex')
}

function readFile(namzuHome: string): ApprovalFile {
	try {
		const parsed = JSON.parse(
			readFileSync(mcpApprovalsPath(namzuHome), 'utf8'),
		) as Partial<ApprovalFile>
		const folders: Record<string, Record<string, string>> = {}
		if (parsed.folders !== null && typeof parsed.folders === 'object') {
			for (const [folder, servers] of Object.entries(parsed.folders)) {
				if (servers === null || typeof servers !== 'object') continue
				const kept: Record<string, string> = {}
				for (const [name, print] of Object.entries(servers)) {
					if (typeof print === 'string') kept[name] = print
				}
				folders[folder] = kept
			}
		}
		return { version: FILE_VERSION, folders }
	} catch {
		return { version: FILE_VERSION, folders: {} }
	}
}

export interface ProjectServerSplit {
	readonly approved: McpServersConfig
	/** Names awaiting an answer: new in the file, or changed since the last one. */
	readonly pending: readonly string[]
}

/** Sort `servers` into those the person approved for `cwd` and those still waiting. */
export function splitProjectMcpServers(
	namzuHome: string,
	cwd: string,
	servers: McpServersConfig | undefined,
): ProjectServerSplit {
	const known = readFile(namzuHome).folders[folderKey(cwd)] ?? {}
	const approved: Record<string, unknown> = {}
	const pending: string[] = []
	for (const [name, entry] of Object.entries(servers ?? {})) {
		if (known[name] === fingerprintMcpServer(entry)) approved[name] = entry
		else pending.push(name)
	}
	return { approved: approved as McpServersConfig, pending }
}

/**
 * Record the person's approval of `names` (all of `servers` when omitted), as
 * the entries read now. Returns the names that were approved.
 */
export function approveProjectMcpServers(
	namzuHome: string,
	cwd: string,
	servers: McpServersConfig,
	names?: readonly string[],
): readonly string[] {
	const chosen = (names ?? Object.keys(servers)).filter((name) => Object.hasOwn(servers, name))
	if (chosen.length === 0) return []
	const file = readFile(namzuHome)
	const key = folderKey(cwd)
	const folder = { ...(file.folders[key] ?? {}) }
	for (const name of chosen) {
		folder[name] = fingerprintMcpServer((servers as Record<string, unknown>)[name])
	}
	const next: ApprovalFile = { version: FILE_VERSION, folders: { ...file.folders, [key]: folder } }
	const path = mcpApprovalsPath(namzuHome)
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
	try {
		writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
		renameSync(temporary, path)
	} catch (error) {
		rmSync(temporary, { force: true })
		throw error
	}
	return chosen
}

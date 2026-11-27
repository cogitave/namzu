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
 * `{ "version": 1, "folders": { "<folder>": { "<server>": "<fingerprint>" } },
 * "plugins": { "<plugin id>": { "<server>": "<fingerprint>" } } }`.
 *
 * `plugins` holds the answers for the remote servers an installed plugin
 * declares. They are keyed by the plugin's id and the server's own name, not by
 * folder: the plugin was installed by the person, and the answer is about what
 * that server's url, headers and transport said. The same fingerprint rule
 * applies, so a plugin update that changes any of them asks again.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { canonicalProjectPath } from '../../permissions/canonical-project.js'
import {
	readFailureReason,
	saveStateFile,
	startNewStateFile,
	unreadableStateFile,
	withStateFileLock,
} from '../state/state-file.js'
import type { McpServersConfig } from './servers.js'

const FILE_VERSION = 1

/** The way out of a damaged approvals file that keeps it. */
export const NEW_APPROVALS_LIST_REMEDY =
	'To start a new list, run namzu mcp approve --new-list; the old one stays where it is kept. Or fix the file and try again.'

/**
 * What is on disk. `folders` is each folder's answers as understood; `raw` is
 * the file as written, so a change keeps whatever it does not understand
 * (another folder's odd entry, a key a newer writer added) as it was.
 */
type ApprovalRead =
	| { readonly state: 'missing' }
	| {
			readonly state: 'ok'
			readonly folders: Readonly<Record<string, Readonly<Record<string, string>>>>
			readonly plugins: Readonly<Record<string, Readonly<Record<string, string>>>>
			readonly raw: Readonly<Record<string, unknown>>
	  }
	| { readonly state: 'unreadable'; readonly reason: string }

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

function readApprovals(namzuHome: string): ApprovalRead {
	let text: string
	try {
		text = readFileSync(mcpApprovalsPath(namzuHome), 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
		return { state: 'unreadable', reason: readFailureReason(error) }
	}
	// A write cut short before its first byte: nothing in it to protect.
	if (text.trim() === '') return { state: 'missing' }
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		return { state: 'unreadable', reason: readFailureReason(error) }
	}
	if (!isRecord(parsed)) return { state: 'unreadable', reason: 'not a list of approvals' }
	const version = parsed.version
	if (version !== undefined && (typeof version !== 'number' || version > FILE_VERSION))
		return { state: 'unreadable', reason: `version ${String(version)} is newer than this Namzu` }
	if (parsed.folders !== undefined && !isRecord(parsed.folders))
		return { state: 'unreadable', reason: 'its "folders" entry is not a mapping' }
	if (parsed.plugins !== undefined && !isRecord(parsed.plugins))
		return { state: 'unreadable', reason: 'its "plugins" entry is not a mapping' }
	return {
		state: 'ok',
		folders: answersOf(parsed.folders),
		plugins: answersOf(parsed.plugins),
		raw: parsed,
	}
}

/** `{ key: { server: fingerprint } }` as understood; an entry that is not text is left out. */
function answersOf(section: unknown): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {}
	if (!isRecord(section)) return out
	for (const [key, servers] of Object.entries(section)) {
		if (!isRecord(servers)) continue
		const kept: Record<string, string> = {}
		for (const [name, print] of Object.entries(servers)) {
			if (typeof print === 'string') kept[name] = print
		}
		out[key] = kept
	}
	return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Why the approvals file cannot be used, when it exists but does not read. */
export function mcpApprovalsProblem(
	namzuHome: string,
): { file: string; reason: string } | undefined {
	const read = readApprovals(namzuHome)
	return read.state === 'unreadable'
		? { file: mcpApprovalsPath(namzuHome), reason: read.reason }
		: undefined
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
	// An unreadable file approves nothing: every server waits, none starts unasked.
	const read = readApprovals(namzuHome)
	const known = (read.state === 'ok' ? read.folders[folderKey(cwd)] : undefined) ?? {}
	const approved: Record<string, unknown> = {}
	const pending: string[] = []
	for (const [name, entry] of Object.entries(servers ?? {})) {
		if (known[name] === fingerprintMcpServer(entry)) approved[name] = entry
		else pending.push(name)
	}
	return { approved: approved as McpServersConfig, pending }
}

/** The one line that says project servers are waiting, for a place with no prompt to put them in. */
export function pendingServersMessage(pending: readonly string[]): string {
	const one = pending.length === 1
	return `${one ? '1 tool server' : `${pending.length} tool servers`} from this project's .mcp.json ${one ? 'is' : 'are'} waiting for your approval and ${one ? "hasn't" : "haven't"} started: ${pending.join(', ')}. Run "namzu mcp approve" to start ${one ? 'it' : 'them'}.`
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
	const prints: Record<string, string> = {}
	for (const name of chosen) {
		prints[name] = fingerprintMcpServer((servers as Record<string, unknown>)[name])
	}
	return recordApprovals(namzuHome, cwd, prints)
}

/**
 * Record the person's approval of the entries they were shown, each as the
 * fingerprint taken when the screen was built. An entry that changed after
 * that is not covered: it differs from what was approved and asks again.
 */
export function approveShownMcpServers(
	namzuHome: string,
	cwd: string,
	shown: readonly { readonly name: string; readonly fingerprint: string }[],
): readonly string[] {
	const prints: Record<string, string> = {}
	for (const { name, fingerprint } of shown) prints[name] = fingerprint
	return recordApprovals(namzuHome, cwd, prints)
}

function recordApprovals(
	namzuHome: string,
	cwd: string,
	prints: Readonly<Record<string, string>>,
): readonly string[] {
	return recordIn(namzuHome, 'folders', folderKey(cwd), prints)
}

/** Write `prints` under `section[key]`, keeping everything else in the file as it was. */
function recordIn(
	namzuHome: string,
	section: 'folders' | 'plugins',
	key: string,
	prints: Readonly<Record<string, string>>,
): readonly string[] {
	const chosen = Object.keys(prints)
	if (chosen.length === 0) return []
	const path = mcpApprovalsPath(namzuHome)
	withStateFileLock(path, () => {
		const read = readApprovals(namzuHome)
		if (read.state === 'unreadable')
			throw unreadableStateFile(path, read.reason, namzuHome, NEW_APPROVALS_LIST_REMEDY)
		const raw = read.state === 'ok' ? read.raw : {}
		const rawSection = isRecord(raw[section]) ? (raw[section] as Record<string, unknown>) : {}
		const current = rawSection[key]
		const entry: Record<string, unknown> = isRecord(current) ? { ...current } : {}
		for (const name of chosen) entry[name] = prints[name] as string
		const next = { ...raw, version: FILE_VERSION, [section]: { ...rawSection, [key]: entry } }
		saveStateFile(path, `${JSON.stringify(next, null, 2)}\n`, { home: namzuHome })
	})
	return chosen
}

/** One remote server a plugin declares, as the approval sees it. */
export interface PluginRemoteApprovalEntry {
	/** `<plugin>@<marketplace>`. */
	readonly pluginId: string
	/** The server's own name in the plugin. */
	readonly server: string
	/** What the fingerprint is taken of: url, headers and transport. */
	readonly entry: unknown
}

/** Whether the person approved this plugin server as it reads now. */
export function isPluginRemoteApproved(
	namzuHome: string,
	item: PluginRemoteApprovalEntry,
): boolean {
	// An unreadable file approves nothing: every server waits, none starts unasked.
	const read = readApprovals(namzuHome)
	if (read.state !== 'ok') return false
	return read.plugins[item.pluginId]?.[item.server] === fingerprintMcpServer(item.entry)
}

/**
 * Record the person's approval of the plugin servers they were shown, each as the
 * fingerprint taken when the screen was built. A server whose url, headers or
 * transport changed after that is not covered: it asks again.
 */
export function approveShownPluginMcpServers(
	namzuHome: string,
	shown: readonly {
		readonly pluginId: string
		readonly server: string
		readonly fingerprint: string
	}[],
): readonly string[] {
	const byPlugin = new Map<string, Record<string, string>>()
	for (const { pluginId, server, fingerprint } of shown) {
		byPlugin.set(pluginId, { ...(byPlugin.get(pluginId) ?? {}), [server]: fingerprint })
	}
	const done: string[] = []
	for (const [pluginId, prints] of byPlugin) {
		for (const server of recordIn(namzuHome, 'plugins', pluginId, prints))
			done.push(`${pluginId}/${server}`)
	}
	return done
}

/**
 * Start a new, empty approvals list when the current one could not be read, for
 * a person who chose to. The old file's bytes are kept in
 * `backups/mcp-approvals.json.corrupted.<ms>` and read back first. Returns where
 * they are kept, or `undefined` when the file reads (or is missing) and so was
 * left as it is.
 */
export function startNewMcpApprovals(namzuHome: string): string | undefined {
	const path = mcpApprovalsPath(namzuHome)
	return withStateFileLock(path, () => {
		if (readApprovals(namzuHome).state !== 'unreadable') return undefined
		const next = { version: FILE_VERSION, folders: {} }
		return startNewStateFile(path, `${JSON.stringify(next, null, 2)}\n`, namzuHome)
	})
}

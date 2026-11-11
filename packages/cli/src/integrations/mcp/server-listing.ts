import { loadConfig, pendingProjectMcpServers } from '../../config/load.js'
import { resolveNamzuHome } from '../state/home.js'
import { approveShownMcpServers, fingerprintMcpServer } from './project-approval.js'
import type { FailedMcpServer } from './servers.js'
import { readUserMcpServers, summarizeUserMcpServer } from './user-config.js'

/** Where a tool server is defined, as the person would name it. */
export type McpServerOrigin = 'your-config' | 'this-project' | 'project-file'

/**
 * What is known about one server right now. `idle` means it is configured and approved and no
 * conversation in this project has started it yet; Namzu starts servers with the first conversation.
 */
export type McpServerState = 'connected' | 'waiting' | 'failed' | 'idle'

export interface McpServerRow {
	readonly name: string
	readonly origin: McpServerOrigin
	readonly state: McpServerState
	/** Why a server failed, phrased for one line. Only on `failed`. */
	readonly reason?: string
	/** What it starts or reaches: a command name or a web origin, never arguments, headers or secrets. */
	readonly detail?: string
	/** Only on `waiting`: what an approval is bound to. It comes back with the approval. */
	readonly fingerprint?: string
}

export interface McpServerListing {
	readonly servers: readonly McpServerRow[]
	/** Set when the configuration could not be read; the list is then empty. */
	readonly error?: string
}

export interface LiveMcpStatus {
	readonly connected: readonly string[]
	/**
	 * `config` is the server's settings as they were when it failed. A failure whose settings have
	 * since changed is not shown: it says nothing about the new settings.
	 */
	readonly failed: readonly (FailedMcpServer & { readonly config?: string })[]
}

const ONE_LINE = /[\r\n\t]+/g
const clip = (value: string, max: number) => value.replace(ONE_LINE, ' ').trim().slice(0, max)

function detailOf(name: string, spec: unknown): string | undefined {
	const summary = summarizeUserMcpServer({ name, spec })
	const text = summary.transport === 'http' ? summary.endpoint : summary.command
	return text ? clip(text, 200) : undefined
}

/**
 * Every tool server this project knows, with its state: the user's own, the project's settings,
 * and the project's `.mcp.json` (which waits for approval before it starts). Reads files only;
 * the live status comes from whichever conversations are open in this project.
 */
export function listMcpServers(options: {
	readonly cwd: string
	readonly live: LiveMcpStatus
}): McpServerListing {
	const { cwd, live } = options
	let effective: Record<string, unknown>
	let declared: Record<string, unknown>
	let pending: readonly string[]
	let userNames: Set<string>
	try {
		effective = (loadConfig({ cwd }).mcpServers ?? {}) as Record<string, unknown>
		const split = pendingProjectMcpServers({ cwd })
		declared = split.declared as Record<string, unknown>
		pending = split.pending
		userNames = new Set(readUserMcpServers().map((entry) => entry.name))
	} catch (error) {
		return {
			servers: [],
			error: clip(error instanceof Error ? error.message : 'The settings could not be read.', 300),
		}
	}
	const failures = new Map<string, string>()
	for (const item of live.failed) {
		const now = effective[item.name]
		if (item.config !== undefined && item.config !== JSON.stringify(now ?? null)) continue
		failures.set(item.name, item.reason)
	}
	const connected = new Set(live.connected)
	const rows: McpServerRow[] = []
	const origin = (name: string): McpServerOrigin =>
		Object.hasOwn(declared, name) && !userNames.has(name)
			? 'project-file'
			: userNames.has(name)
				? 'your-config'
				: 'this-project'
	for (const [name, spec] of Object.entries(effective)) {
		const detail = detailOf(name, spec)
		const failure = failures.get(name)
		rows.push({
			name,
			origin: origin(name),
			state: failure !== undefined ? 'failed' : connected.has(name) ? 'connected' : 'idle',
			...(failure !== undefined ? { reason: clip(failure, 300) } : {}),
			...(detail ? { detail } : {}),
		})
	}
	for (const name of pending) {
		if (rows.some((row) => row.name === name)) continue
		const detail = detailOf(name, declared[name])
		rows.push({
			name,
			origin: 'project-file',
			state: 'waiting',
			fingerprint: fingerprintMcpServer(declared[name]),
			...(detail ? { detail } : {}),
		})
	}
	return { servers: rows }
}

/**
 * Approve servers the person was shown waiting, through the same record `namzu mcp approve`
 * writes. An entry that changed since it was listed does not match its fingerprint and stays
 * waiting.
 */
export function approveListedMcpServers(
	cwd: string,
	shown: readonly { readonly name: string; readonly fingerprint: string }[],
): readonly string[] {
	return approveShownMcpServers(resolveNamzuHome(), cwd, shown)
}

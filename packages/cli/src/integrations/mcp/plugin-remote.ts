/**
 * The remote tool servers an installed plugin declares.
 *
 * The plugin reader parses a plugin's `url` servers and nothing connects at
 * install or load. A server starts only after the person approved it, through
 * the same `mcp-approvals.json` the project's `.mcp.json` uses (the `plugins`
 * section, keyed by plugin id and server name), and only while its plugin is on.
 * A server whose environment variable is unset, or that uses a reference where
 * none is expanded, is `needs setup` and is never started.
 *
 * This file does three things: it turns a plugin's declared servers into
 * entries with a spec the MCP manager can start and a fingerprint the approval
 * is bound to; it reads those entries for the installed plugins without a
 * session (for `namzu mcp servers` and the Desktop Connectors table); and it
 * owns the live connections of one session, which follow the plugin's on/off
 * state and the approval file.
 */

import type { PluginManifest, PluginRemoteMCPServerConfig, Toolset } from '@namzu/sdk'
import { deferred } from '@namzu/sdk'

import type { PluginConfig, PluginScope } from '../../config/schema.js'
import {
	type InstalledCandidate,
	loadInstalledManifest,
	planInstalledPlugins,
	readInstalledManifest,
} from '../plugins/installed-source.js'
import { resolveNamzuHome } from '../state/home.js'
import { isTrusted } from '../trust/store.js'
import { fingerprintMcpServer, isPluginRemoteApproved } from './project-approval.js'
import type { McpServerRow, McpServerState } from './server-listing.js'
import {
	type McpConnection,
	type McpServerSpec,
	type McpStartOptions,
	startMcpServers,
} from './servers.js'

/** One remote server of one installed plugin. */
export interface PluginRemoteServer {
	/** `<plugin>@<marketplace>`. */
	readonly pluginId: string
	readonly pluginName: string
	/** The server's own name in the plugin. */
	readonly server: string
	/** The name the MCP manager and the tool roster use: unique across plugins. */
	readonly runtimeName: string
	/** Absent when the server needs setup: nothing can start it. */
	readonly spec?: McpServerSpec
	/** What an approval is bound to (url, headers, transport). Absent with `spec`. */
	readonly entry?: unknown
	/** Why it cannot start yet, in one line. */
	readonly needsSetup?: string
	/** The web origin it reaches, never a header or a path with a secret. */
	readonly detail?: string
}

/** Letters, digits, `_` and `-`, starting with a letter, at most 64: what a server name may be. */
export function pluginServerRuntimeName(pluginName: string, server: string): string {
	const clean = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_')
	const joined = `${clean(pluginName)}-${clean(server)}`
	return (/^[A-Za-z]/.test(joined) ? joined : `p${joined}`).slice(0, 64)
}

/** The entry an approval is fingerprinted from: exactly url, headers and transport. */
export function remoteApprovalEntry(server: PluginRemoteMCPServerConfig): unknown {
	return {
		url: server.url,
		transport: server.transport ?? 'http',
		headers: server.headers ?? {},
	}
}

/** The spec the MCP manager starts. A header's `${VAR}` is read when it connects. */
export function remoteSpec(server: PluginRemoteMCPServerConfig): McpServerSpec {
	return {
		url: server.url,
		...(server.headers ? { headers: server.headers } : {}),
		...(server.transport === 'sse' ? { transport: 'sse' as const } : {}),
	}
}

function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin
	} catch {
		return undefined
	}
}

/** What the reader said about servers that cannot start: remote ones only, by server name. */
export interface NeedsSetupFinding {
	readonly code: string
	readonly message: string
	readonly server?: { readonly name: string; readonly kind: 'local' | 'remote' }
}

/** The one line a `needs setup` finding gives: its reason without the leading name or the tail. */
function setupReason(finding: NeedsSetupFinding): string {
	const name = finding.server?.name ?? ''
	return finding.message.replace(`${name} needs setup: `, '').replace(/\. It is not started\.$/, '')
}

/**
 * The remote servers of one plugin as entries: the ones the reader admitted,
 * and the ones it set aside as needing setup (they appear, with the reason, and
 * never start).
 */
export function remoteServersOfPlugin(
	plugin: { readonly id: string; readonly name: string },
	manifest: Pick<PluginManifest, 'remoteMcpServers'> | undefined,
	findings: readonly NeedsSetupFinding[],
): readonly PluginRemoteServer[] {
	const out: PluginRemoteServer[] = []
	const taken = new Set<string>()
	const add = (item: Omit<PluginRemoteServer, 'pluginId' | 'pluginName' | 'runtimeName'>): void => {
		const runtimeName = pluginServerRuntimeName(plugin.name, item.server)
		if (taken.has(runtimeName)) return
		taken.add(runtimeName)
		out.push({ pluginId: plugin.id, pluginName: plugin.name, runtimeName, ...item })
	}
	for (const server of manifest?.remoteMcpServers ?? []) {
		const origin = originOf(server.url)
		add({
			server: server.name,
			spec: remoteSpec(server),
			entry: remoteApprovalEntry(server),
			...(origin ? { detail: origin } : {}),
		})
	}
	for (const finding of findings) {
		if (finding.code !== 'mcp-needs-setup' || finding.server?.kind !== 'remote') continue
		add({ server: finding.server.name, needsSetup: setupReason(finding) })
	}
	return out
}

export interface InstalledRemoteRead {
	readonly servers: readonly PluginRemoteServer[]
	readonly problems: readonly string[]
}

/**
 * The remote servers of the plugins this computer installed and that are on
 * here, read from their install folders. Starts nothing and connects to
 * nothing. A plugin that cannot be read is named in `problems` and does not
 * stop the others.
 */
export async function readInstalledRemoteServers(options: {
	readonly home: string
	readonly cwd: string
	readonly projectTrusted: boolean
	readonly allowedScopes: readonly PluginScope[]
}): Promise<InstalledRemoteRead> {
	const plan = planInstalledPlugins(options)
	const servers: PluginRemoteServer[] = []
	const problems: string[] = []
	const names = new Set(plan.candidates.map((candidate) => candidate.name))
	for (const candidate of plan.candidates) {
		if (!candidate.answer.on) continue
		try {
			servers.push(...(await readOne(candidate, options, names)))
		} catch (error) {
			problems.push(`${candidate.id}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
	return { servers: uniqueRuntimeNames(servers), problems }
}

/**
 * Two plugins can build the same runtime name (`a-b` + `c`, and `a` + `b-c`). The later one gets
 * a counter, so rows, approvals, status and tool roster ids each name one server.
 */
export function uniqueRuntimeNames(
	servers: readonly PluginRemoteServer[],
): readonly PluginRemoteServer[] {
	const taken = new Set<string>()
	return servers.map((server) => {
		let name = server.runtimeName
		for (let n = 2; taken.has(name); n++) {
			const suffix = `-${n}`
			name = `${server.runtimeName.slice(0, 64 - suffix.length)}${suffix}`
		}
		taken.add(name)
		return name === server.runtimeName ? server : { ...server, runtimeName: name }
	})
}

async function readOne(
	candidate: InstalledCandidate,
	options: { readonly home: string; readonly cwd: string },
	names: ReadonlySet<string>,
): Promise<readonly PluginRemoteServer[]> {
	const where = { home: options.home, cwd: options.cwd, installedNames: names }
	const read = await readInstalledManifest(candidate, where)
	const manifest = read.manifest ?? (await loadInstalledManifest(candidate, where))
	return remoteServersOfPlugin({ id: candidate.id, name: candidate.name }, manifest, read.findings)
}

/**
 * The remote servers of the plugins installed for a folder, as a session with
 * `plugins.enabled` would load them. Empty while plugins are off: nothing
 * installed runs then, and nothing is listed as waiting.
 */
export async function readFolderRemoteServers(options: {
	readonly cwd: string
	readonly plugins: PluginConfig | undefined
	readonly home?: string
}): Promise<InstalledRemoteRead> {
	if (options.plugins?.enabled !== true) return { servers: [], problems: [] }
	let trusted = false
	try {
		trusted = isTrusted(options.cwd)
	} catch {
		trusted = false
	}
	return readInstalledRemoteServers({
		home: options.home ?? resolveNamzuHome(),
		cwd: options.cwd,
		projectTrusted: trusted,
		allowedScopes: options.plugins.allowedScopes ?? ['project', 'user'],
	})
}

/** The names of the environment variables a server's headers read, for the approval screen. */
export function headerVariablesOf(server: PluginRemoteServer): readonly string[] {
	const found = new Set<string>()
	for (const value of Object.values(server.spec?.headers ?? {})) {
		for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
			if (match[1]) found.add(match[1])
		}
	}
	return [...found].sort()
}

/** Whether the person approved this server as it reads now. */
export function pluginServerApproved(home: string, server: PluginRemoteServer): boolean {
	return (
		server.entry !== undefined &&
		isPluginRemoteApproved(home, {
			pluginId: server.pluginId,
			server: server.server,
			entry: server.entry,
		})
	)
}

/** What a session knows live of its plugin servers, by runtime name. */
export interface PluginRemoteLive {
	readonly connected: readonly string[]
	readonly failed: readonly { readonly name: string; readonly reason: string }[]
}

export type PluginRemoteRow = McpServerRow & { readonly plugin: string }

const clipOneLine = (value: string, max: number): string =>
	value
		.replace(/[\r\n\t]+/g, ' ')
		.trim()
		.slice(0, max)

/** The rows `namzu mcp servers` and the Desktop Connectors table show for plugin remote servers. */
export function pluginRemoteRows(
	home: string,
	servers: readonly PluginRemoteServer[],
	live: PluginRemoteLive,
): readonly PluginRemoteRow[] {
	const connected = new Set(live.connected)
	const failures = new Map(live.failed.map((item) => [item.name, item.reason]))
	return servers.map((server): PluginRemoteRow => {
		const base = {
			name: server.runtimeName,
			origin: 'plugin' as const,
			plugin: server.pluginName,
			...(server.detail ? { detail: server.detail } : {}),
		}
		if (server.needsSetup !== undefined) {
			return {
				...base,
				state: 'needs-setup' satisfies McpServerState,
				reason: clipOneLine(server.needsSetup, 300),
			}
		}
		if (!pluginServerApproved(home, server)) {
			return {
				...base,
				state: 'waiting',
				fingerprint: fingerprintOf(server),
				...(headerVariablesOf(server).length > 0 ? { sends: headerVariablesOf(server) } : {}),
			}
		}
		const failure = failures.get(server.runtimeName)
		if (failure !== undefined)
			return { ...base, state: 'failed', reason: clipOneLine(failure, 300) }
		return { ...base, state: connected.has(server.runtimeName) ? 'connected' : 'idle' }
	})
}

/** The value an approval of this server is bound to. */
export function fingerprintOf(server: PluginRemoteServer): string {
	return fingerprintMcpServer(server.entry)
}

// ---------------------------------------------------------------------------
// One session's live connections
// ---------------------------------------------------------------------------

export interface PluginRemoteHost {
	/** One pair of live entries per remote server; they carry tools only while connected. */
	readonly toolsets: readonly Toolset[]
	/**
	 * Start the servers that are on, approved and not yet started, and close the
	 * ones that are no longer. Call it after a plugin is turned on or off and after
	 * an approval. Never throws.
	 */
	sync(): void
	status(): PluginRemoteLive
	/** The servers the host knows, for listings. */
	servers(): readonly PluginRemoteServer[]
	close(): Promise<void>
}

interface Slot {
	readonly server: PluginRemoteServer
	connection: McpConnection | undefined
	unsubscribe: Array<() => void>
	readonly listeners: Set<() => void>
}

/**
 * Build the live side for one session. Entries are fixed at creation, so a
 * plugin turned on later has its slots already in the roster; each slot starts
 * a connection only while its plugin is on, the entry is approved and it does
 * not need setup, and closes it when any of that stops being true.
 */
export function createPluginRemoteHost(options: {
	readonly home: string
	readonly servers: readonly PluginRemoteServer[]
	/** Whether the plugin is on right now. */
	readonly isOn: (pluginId: string) => boolean
	readonly start: McpStartOptions
}): PluginRemoteHost {
	const slots: Slot[] = options.servers.map((server) => ({
		server,
		connection: undefined,
		unsubscribe: [],
		listeners: new Set<() => void>(),
	}))
	let closed = false
	const toolsets: Toolset[] = []
	for (const slot of slots) {
		const name = slot.server.runtimeName
		const source = {
			id: `mcp:${name}`,
			kind: 'mcp_server' as const,
			name,
			mcpServer: { name, readOnlyHintTrusted: false },
		}
		const onChange = (listener: () => void): (() => void) => {
			slot.listeners.add(listener)
			return () => slot.listeners.delete(listener)
		}
		const part = (index: 0 | 1): Toolset =>
			deferred({
				source,
				tools: () => slot.connection?.toolsets[index]?.tools() ?? [],
				onChange,
			})
		toolsets.push(part(0), part(1))
	}
	const notify = (slot: Slot): void => {
		for (const listener of [...slot.listeners]) listener()
	}
	const stop = async (slot: Slot): Promise<void> => {
		const connection = slot.connection
		if (connection === undefined) return
		slot.connection = undefined
		for (const off of slot.unsubscribe.splice(0)) off()
		notify(slot)
		await connection.close().catch(() => undefined)
	}
	const wanted = (slot: Slot): boolean =>
		slot.server.spec !== undefined &&
		options.isOn(slot.server.pluginId) &&
		pluginServerApproved(options.home, slot.server)
	const reconcile = (closeOnly: boolean): void => {
		if (closed) return
		for (const slot of slots) {
			const want = wanted(slot)
			if (want && slot.connection === undefined && !closeOnly) {
				const connection = startMcpServers(
					{ [slot.server.runtimeName]: slot.server.spec as McpServerSpec },
					options.start,
				)
				slot.connection = connection
				for (const entry of connection.toolsets) {
					if (entry.onChange) slot.unsubscribe.push(entry.onChange(() => notify(slot)))
				}
				slot.unsubscribe.push(connection.onSettled(() => notify(slot)))
			} else if (!want && slot.connection !== undefined) {
				void stop(slot)
			}
		}
	}
	return {
		toolsets,
		servers: () => options.servers,
		sync: () => reconcile(false),
		status() {
			// A plugin removed or an approval changed on disk since the last sync stops showing as live.
			reconcile(true)
			const connected: string[] = []
			const failed: { name: string; reason: string }[] = []
			for (const slot of slots) {
				const state = slot.connection?.current()
				if (state === undefined) continue
				if (state.connected.length > 0) connected.push(slot.server.runtimeName)
				for (const item of state.failed)
					failed.push({ name: slot.server.runtimeName, reason: item.reason })
			}
			return { connected, failed }
		},
		async close() {
			closed = true
			await Promise.allSettled(slots.map((slot) => stop(slot)))
		},
	}
}

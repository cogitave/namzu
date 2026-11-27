import { loadConfig } from '../../config/load.js'
import type { PluginConfig } from '../../config/schema.js'
import { resolveNamzuHome } from '../state/home.js'
import {
	type PluginRemoteLive,
	pluginRemoteRows,
	readFolderRemoteServers,
} from './plugin-remote.js'
import { approveShownPluginMcpServers } from './project-approval.js'
import {
	type LiveMcpStatus,
	type McpServerListing,
	approveListedMcpServers,
	listMcpServers,
} from './server-listing.js'

/**
 * Every tool server this folder knows: the user's own, the project's, and the
 * remote servers of the installed plugins that are on. Reads files only.
 */
export async function listAllMcpServers(options: {
	readonly cwd: string
	readonly live: LiveMcpStatus
	readonly plugins: PluginConfig | undefined
}): Promise<McpServerListing> {
	const base = listMcpServers({ cwd: options.cwd, live: options.live })
	const remote = await readFolderRemoteServers({ cwd: options.cwd, plugins: options.plugins })
	if (remote.servers.length === 0) return base
	const live: PluginRemoteLive = {
		connected: options.live.connected,
		failed: options.live.failed.map(({ name, reason }) => ({ name, reason })),
	}
	// A name the person's own settings use is theirs; the plugin's server of that name is not listed.
	const taken = new Set(base.servers.map((row) => row.name))
	const rows = pluginRemoteRows(resolveNamzuHome(), remote.servers, live).filter(
		(row) => !taken.has(row.name),
	)
	return { ...base, servers: [...base.servers, ...rows] }
}

/**
 * Approve servers the person was shown waiting: project ones through the folder's list, and a
 * plugin's through the `plugins` section, found again by the name the row carried. A row whose
 * entry changed since it was listed does not match and stays waiting.
 */
export async function approveListedAnyMcpServers(options: {
	readonly cwd: string
	readonly plugins: PluginConfig | undefined
	readonly shown: readonly { readonly name: string; readonly fingerprint: string }[]
}): Promise<readonly string[]> {
	const read = await readFolderRemoteServers({ cwd: options.cwd, plugins: options.plugins })
	// A name the person's own settings or the project use is theirs, as in the list: a row of that
	// name is a project row, never the plugin's.
	const owned = new Set(
		listMcpServers({ cwd: options.cwd, live: { connected: [], failed: [] } }).servers.map(
			(row) => row.name,
		),
	)
	const servers = read.servers.filter((server) => !owned.has(server.runtimeName))
	const byName = new Map(servers.map((server) => [server.runtimeName, server]))
	const projectRows = options.shown.filter((row) => !byName.has(row.name))
	const pluginRows = options.shown.flatMap((row) => {
		const server = byName.get(row.name)
		return server
			? [
					{
						name: row.name,
						pluginId: server.pluginId,
						server: server.server,
						fingerprint: row.fingerprint,
					},
				]
			: []
	})
	const approved: string[] = []
	if (projectRows.length > 0) approved.push(...approveListedMcpServers(options.cwd, projectRows))
	if (pluginRows.length > 0) {
		approveShownPluginMcpServers(resolveNamzuHome(), pluginRows)
		approved.push(...pluginRows.map((row) => row.name))
	}
	return approved
}

/**
 * The folder's `plugins` settings, or nothing when the settings do not read: the list then
 * says so through the project's own entries, and no plugin server is listed or approved on a guess.
 */
export function pluginConfigFor(cwd: string): PluginConfig | undefined {
	try {
		return loadConfig({ cwd }).plugins
	} catch {
		return undefined
	}
}

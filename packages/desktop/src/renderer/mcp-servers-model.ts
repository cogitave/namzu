import type { McpServerView, McpServersView } from '../shared/protocol.js'

const WHERE: Record<McpServerView['origin'], string> = {
	'your-config': 'Your own settings',
	'this-project': 'This project’s settings',
	'project-file': '.mcp.json in this project',
}

const STATE: Record<McpServerView['state'], string> = {
	connected: 'Connected',
	waiting: 'Waiting for your approval',
	failed: 'Failed',
	idle: 'Not connected right now',
}

export interface McpServerRowView {
	name: string
	where: string
	state: McpServerView['state']
	stateLabel: string
	/** The command or address, when the engine named one. */
	detail?: string
	/** Why it failed, in the engine's own words. */
	reason?: string
}

export function mcpServerRowView(server: McpServerView): McpServerRowView {
	return {
		name: server.name,
		where: WHERE[server.origin],
		state: server.state,
		stateLabel: STATE[server.state],
		...(server.detail ? { detail: server.detail } : {}),
		...(server.state === 'failed' && server.reason ? { reason: server.reason } : {}),
	}
}

/** The servers waiting on a yes, each with what the approval is bound to. */
export function waitingServers(view: McpServersView | undefined) {
	return (view?.servers ?? []).flatMap((server) =>
		server.state === 'waiting' && server.fingerprint
			? [{ name: server.name, fingerprint: server.fingerprint }]
			: [],
	)
}

export function approveLabel(count: number): string {
	return count === 1 ? 'Approve this server' : `Approve these ${count} servers`
}

/** What the group says under its title: where the list comes from and what it cannot do. */
export function mcpServersNote(projectName: string | undefined): string {
	return `${projectName ? `The tool servers for “${projectName}”.` : 'The tool servers for the open project.'} This list is read-only: add or change servers in your config file, or with “namzu mcp” in the terminal.`
}

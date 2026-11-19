import type { UserMcpServerChange, UserMcpServerView } from '../shared/config-lists-protocol.js'
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
	origin: McpServerView['origin']
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
		origin: server.origin,
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

/** What the group says under its title: where the list comes from and what can be changed here. */
export function mcpServersNote(projectName: string | undefined): string {
	return `${projectName ? `The tool servers for “${projectName}”.` : 'The tool servers for the open project.'} You can add, change and remove the ones in your own settings here; a project’s own servers are approved here and changed in the project.`
}

/** What the Tool servers row says while no project is open. */
export const OPEN_A_PROJECT_FOR_SERVERS = 'Open a project to see its servers.'

/** Said under the form and the list: what is kept and never shown. */
export function variablesNote(file: string | undefined): string {
	return `Variables and headers are edited in the file${file ? `: ${file}` : ''}.`
}

/** What a server in the user's file starts or reaches, for the list: the command, or the address. */
export function userServerDetail(server: UserMcpServerView): string | undefined {
	if (server.kind === 'command') return server.command
	if (server.kind === 'address' && server.origin) return server.origin
	if (server.kind === 'address' && server.url) {
		try {
			return new URL(server.url).origin
		} catch {
			return undefined
		}
	}
	return undefined
}

/** What the person is typing for one server. */
export interface ServerDraft {
	mode: 'add' | 'edit'
	name: string
	kind: 'command' | 'address'
	command: string
	args: string[]
	url: string
}

export const emptyDraft = (): ServerDraft => ({
	mode: 'add',
	name: '',
	kind: 'command',
	command: '',
	args: [],
	url: '',
})

export function draftFor(server: UserMcpServerView): ServerDraft {
	return {
		mode: 'edit',
		name: server.name,
		kind: server.kind === 'address' ? 'address' : 'command',
		command: server.command ?? '',
		args: [...(server.args ?? [])],
		url: server.url ?? '',
	}
}

/** What is sent: a command with its arguments, or an address, never both. The engine checks the rest. */
export function changeFromDraft(draft: ServerDraft): UserMcpServerChange {
	return {
		mode: draft.mode,
		name: draft.name.trim(),
		...(draft.kind === 'command'
			? {
					command: draft.command.trim(),
					...(draft.args.length > 0 ? { args: draft.args } : {}),
				}
			: { url: draft.url.trim() }),
	}
}

/** What is missing before anything is sent. The engine refuses a wrong name or address in its own words. */
export function draftMissing(draft: ServerDraft): string | undefined {
	if (draft.name.trim() === '') return 'Name the server.'
	if (draft.kind === 'command' && draft.command.trim() === '') return 'Enter the command to run.'
	if (draft.kind === 'address' && draft.url.trim() === '') return 'Enter the server’s address.'
	return undefined
}

/** The question asked before a server's command is saved, as the dialog words it. */
export function serverConfirmationCopy(message: string) {
	return {
		title: 'Let this server run a program?',
		description: message,
		confirm: 'Save server',
		cancel: 'Cancel',
	}
}

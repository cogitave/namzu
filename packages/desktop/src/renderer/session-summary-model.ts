import type { ThreadUsage } from '../shared/projection.js'
import type { McpServersView, ProjectGitView } from '../shared/protocol.js'
import { CUT_NOTE, type ChangeTotals, formatLineCount } from './changes-totals.js'
import { contextRingModel } from './context-ring.js'
import { type McpServerRowView, mcpServerRowView } from './mcp-servers-model.js'
import { elapsedLabel } from './transcript-layout.js'

/**
 * What the conversation's work is doing, as the details popover and the session panel both say it.
 * `finished` is the number of background jobs that have ended; it is absent where the list was not read.
 */
export type SessionWork =
	| { state: 'checking' }
	| { state: 'unavailable' }
	| { state: 'known'; running: number; needsAttention: boolean; finished?: number }

/** Where the project's tool servers stand, as far as the window knows. */
export type SessionServers =
	| { state: 'hidden' }
	| { state: 'checking' }
	| { state: 'untrusted' }
	| { state: 'known'; view: McpServersView }

export interface SessionSummaryInput {
	/** `kind: 'chat'` is a conversation in Namzu's own chats folder: no repository, so no branch. */
	project?: { name: string; path: string; trusted: boolean; kind?: 'chat' }
	/** Null hides the branch row. */
	git: ProjectGitView | null
	usage?: ThreadUsage | undefined
	servers: SessionServers
	totals: ChangeTotals
	work: SessionWork
}

export type ContextTone = 'normal' | 'high' | 'full'

export interface SessionSummary {
	environment: {
		host: string
		folder?: { name: string; path: string }
		branch?: { text: string; title: string /** The last commit's first line. */; subject?: string }
		/** Said where the branch cannot be read, so the row is never silently missing. */
		branchNote?: string
	}
	context: {
		measured: boolean
		/** "7%", "about 7%", or "Not measured yet". */
		text: string
		fraction: number
		tone: ContextTone
	}
	toolServers?: {
		label: string
		/** "2 connected", "None", "Checking…". */
		count: string
		rows: McpServerRowView[]
		/** "1 needs approval · 1 failed", only when something is not fine. */
		attention?: string
	}
	changes: {
		hasChanges: boolean
		added: string
		removed: string
		cut: boolean
		/** What is said where there are no changes. */
		empty: string
		/** Why the totals can differ from what git sees. */
		note: string
	}
	background: {
		/** "None", "2 running", "Needs attention", "Checking…", "Not known". */
		text: string
		finished: number
		attention: boolean
	}
}

export const TOOL_SERVERS_LABEL = 'Tool servers'
/** What a chat's own folder is called, in plain words. */
export const CHAT_FOLDER_LABEL = 'Chat folder'
const CHANGES_NOTE = 'Counted from this conversation’s edits.'

function backgroundText(work: SessionWork): string {
	if (work.state === 'checking') return 'Checking…'
	if (work.state === 'unavailable') return 'Not known'
	if (work.needsAttention) return 'Needs attention'
	return work.running > 0 ? `${work.running} running` : 'None'
}

function serverSummary(servers: SessionServers): SessionSummary['toolServers'] {
	if (servers.state === 'hidden') return undefined
	if (servers.state === 'checking')
		return { label: TOOL_SERVERS_LABEL, count: 'Checking…', rows: [] }
	if (servers.state === 'untrusted')
		return {
			label: TOOL_SERVERS_LABEL,
			count: 'Trust this folder to read them',
			rows: [],
		}
	const rows = servers.view.servers.map(mcpServerRowView)
	const connected = rows.filter((row) => row.state === 'connected').length
	const waiting = rows.filter((row) => row.state === 'waiting').length
	const failed = rows.filter((row) => row.state === 'failed').length
	const parts: string[] = []
	if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? 'needs' : 'need'} approval`)
	if (failed > 0) parts.push(`${failed} failed`)
	return {
		label: TOOL_SERVERS_LABEL,
		count: rows.length === 0 ? 'None' : `${connected} connected`,
		rows,
		...(parts.length ? { attention: parts.join(' · ') } : {}),
	}
}

/** The one reading of a conversation's state that both the popover and the panel draw from. */
export function sessionSummary(input: SessionSummaryInput): SessionSummary {
	const ring = contextRingModel(input.usage)
	const git = input.git
	const environment: SessionSummary['environment'] = { host: 'This computer' }
	if (input.project) {
		const chat = input.project.kind === 'chat'
		environment.folder = {
			name: chat ? CHAT_FOLDER_LABEL : input.project.name,
			path: input.project.path,
		}
		if (chat) {
			// A chat's folder is not a repository: no branch and no note about one.
		} else if (git) {
			const name = git.branch ?? 'Detached'
			environment.branch = {
				text: name,
				title: [name, git.subject].filter(Boolean).join(' · '),
				...(git.subject ? { subject: git.subject } : {}),
			}
		} else if (!input.project.trusted) {
			environment.branchNote = 'Trust this folder to see its branch'
		}
	}
	const servers = serverSummary(input.servers)
	return {
		environment,
		context: ring
			? {
					measured: true,
					text: `${input.usage?.measuredBy === 'estimate' ? 'about ' : ''}${ring.percent}%`,
					fraction: ring.fraction,
					tone: ring.tone,
				}
			: { measured: false, text: 'Not measured yet', fraction: 0, tone: 'normal' },
		...(servers ? { toolServers: servers } : {}),
		changes: {
			hasChanges: input.totals.added + input.totals.removed > 0,
			added: formatLineCount(input.totals.added),
			removed: formatLineCount(input.totals.removed),
			cut: input.totals.cut,
			empty: 'No file changes yet',
			note: input.totals.cut ? `${CHANGES_NOTE} ${CUT_NOTE}` : CHANGES_NOTE,
		},
		background: {
			text: backgroundText(input.work),
			finished: input.work.state === 'known' ? (input.work.finished ?? 0) : 0,
			attention: input.work.state === 'known' && input.work.needsAttention,
		},
	}
}

/** "N finished", or nothing when none has. */
export function finishedText(count: number): string | undefined {
	return count > 0 ? `${count} finished` : undefined
}

/** A job's running time in the same words the live step uses ("1m 5s"); never negative. */
export function jobElapsed(startedAt: number, now: number): string {
	return elapsedLabel(Math.max(0, now - startedAt))
}

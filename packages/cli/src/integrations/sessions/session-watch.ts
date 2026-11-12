/**
 * Reading a session another process is writing.
 *
 * `namzu watch` looks at a session without being part of it. Everything here
 * is read-only by construction: the log is opened through a handle that is
 * never asked to claim, append or release, the lease is read from its files
 * and never renewed, and no index, project or identity file is created.
 *
 * ## What the log can and cannot say
 *
 * The log is append-only and holds settled records: a message when its step
 * ends, a tool's events as they happen, turn boundaries, questions put to a
 * person. The text a model is writing right now, and a tool's progress, are
 * live events that are never appended (`docs/sdk/session-log.md`). A watcher
 * therefore shows a step when the step ends, and says so; it never pretends
 * to stream.
 *
 * ## How it follows
 *
 * {@link SessionFollower.poll} reads only the bytes after the last record it
 * verified. A log that got shorter or is another file now (a writer cut a
 * torn tail, the file was replaced) is read again from the start. The status
 * comes from the same facts the session list uses: the turn the log leaves
 * open, whether its writer's lease is still live, and the questions nobody
 * has answered.
 */

import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
	DiskSessionLog,
	type HITLDecisionRequest,
	type Message,
	ProjectDocumentSchema,
	type ProjectId,
	type RecordPointer,
	type SessionId,
	type SessionLease,
	SessionPaths,
	type SessionRecord,
	type TenantId,
	asSessionId,
	foldSessionMessages,
	isEntityId,
	isLeaseLive,
	readSessionLease,
} from '@namzu/sdk'
import { terminalDisplayText } from '../../tui/terminal-display.js'
import { ConversationFactsFold } from './conversation-facts.js'
import { conversationTitle } from './store.js'

/** What a watcher says a session is doing. */
export type WatchState = 'running' | 'waiting' | 'finished' | 'interrupted' | 'idle'

/** How the last turn ended, when it did. */
export type WatchOutcome = 'completed' | 'failed' | 'cancelled' | 'stopped'

export interface WatchStatus {
	readonly state: WatchState
	/** Set when `state` is `finished`: how the last turn ended. */
	readonly outcome?: WatchOutcome
	/** One plain sentence for the status line. */
	readonly sentence: string
	/** What a person must answer, in the kernel's words, when the session waits or was waiting. */
	readonly asking?: string
	/** The process that holds the session, when its lease names one. */
	readonly holderPid?: number
}

/** Where a session's files are, and whose it is. */
export interface WatchTarget {
	readonly paths: SessionPaths
	readonly projectId: ProjectId
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	/** The folder the session was started in, for display. */
	readonly folder: string
}

export interface WatchSnapshot {
	readonly status: WatchStatus
	/** The folded conversation; stable between polls when nothing was appended. */
	readonly messages: readonly Message[]
	readonly records: readonly SessionRecord[]
	/** Records were appended (or the log was read again) since the previous poll. */
	readonly changed: boolean
	/** The log was read again from its start: what was shown before may no longer stand. */
	readonly reset: boolean
	/** The turn a live process is running now, when the session is running or waiting. */
	readonly liveTurnId?: string
	/** The chain broke at this seq; what precedes it is shown. */
	readonly brokenAt?: number
}

export class SessionNotFoundError extends Error {
	override readonly name = 'SessionNotFoundError'
}

/** The log is there but nothing in it can be verified, so nothing of it is shown. */
export class SessionUnreadableError extends Error {
	override readonly name = 'SessionUnreadableError'
}

export class SessionNotOwnedError extends Error {
	override readonly name = 'SessionNotOwnedError'
}

interface FollowerOptions {
	readonly target: WatchTarget
	/** Clock, for tests. */
	readonly now?: () => number
	/** Whether a process of this machine is alive, for tests. */
	readonly isProcessAlive?: (pid: number) => boolean
}

/** Whether a process of this machine is alive. A process we may not signal is alive. */
export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

const ASK_PHRASES: Readonly<Record<string, string>> = {
	tool_review: 'It is waiting for a tool call to be approved.',
	user_question: 'It is waiting for an answer to a question.',
	plan_approval: 'It is waiting for a plan to be approved.',
	iteration_checkpoint: 'It is waiting at a checkpoint.',
}

function plainOneLine(text: string, limit = 160): string {
	const flat = terminalDisplayText(text).replace(/\s+/g, ' ').trim()
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** The question or review a decision request puts to a person, in the words the kernel recorded. */
export function askingOf(request: HITLDecisionRequest): string {
	switch (request.type) {
		case 'user_question':
			return plainOneLine(request.question.question)
		case 'tool_review': {
			const names = request.toolCalls.map((call) => call.name)
			return `approve ${names.length === 1 ? 'the call to' : 'the calls to'} ${plainOneLine(names.join(', '), 80)}`
		}
		case 'plan_approval':
			return 'approve the plan'
		case 'iteration_checkpoint':
			return 'continue past a checkpoint'
	}
}

function holderPidOf(lease: SessionLease | null): number | undefined {
	const match = /^namzu(?:-cli)?:(\d+):/.exec(lease?.holder ?? '')
	return match ? Number(match[1]) : undefined
}

/** Follows one session's log. One instance per watcher; it never writes. */
export class SessionFollower {
	readonly #target: WatchTarget
	readonly #now: () => number
	readonly #alive: (pid: number) => boolean
	readonly #log: DiskSessionLog
	readonly #file: string
	readonly #sessionDir: string

	#records: SessionRecord[] = []
	#messages: Message[] = []
	#pointer: RecordPointer | undefined
	#size = -1
	#identity: string | undefined
	#fold = new ConversationFactsFold()
	#requests = new Map<string, HITLDecisionRequest>()
	#lastEnd: { outcome: WatchOutcome } | undefined
	#started = false
	#brokenAt: number | undefined
	#unverified = false

	constructor(options: FollowerOptions) {
		this.#target = options.target
		this.#now = options.now ?? Date.now
		this.#alive = options.isProcessAlive ?? processIsAlive
		this.#log = DiskSessionLog.at(options.target.paths, { sessionId: options.target.sessionId })
		this.#file = options.target.paths.sessionLog({ sessionId: options.target.sessionId })
		this.#sessionDir = options.target.paths.sessionDir({ sessionId: options.target.sessionId })
	}

	/** Read what was appended since the last call, and say what the session is doing. */
	async poll(): Promise<WatchSnapshot> {
		let info: { size: number; identity: string }
		try {
			if ((await lstat(this.#file)).isSymbolicLink()) {
				throw new SessionUnreadableError(
					`The log of session ${this.#target.sessionId} is a link, and links are not followed, so it is not shown.`,
				)
			}
			const s = await stat(this.#file)
			info = { size: s.size, identity: `${s.dev}:${s.ino}` }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new SessionNotFoundError(`The log of session ${this.#target.sessionId} is gone.`)
			}
			throw error
		}
		let reset = false
		if (
			this.#size >= 0 &&
			(info.size < this.#size || (this.#identity !== undefined && this.#identity !== info.identity))
		) {
			this.#restart()
			reset = true
		}
		let changed = reset
		if (info.size !== this.#size) {
			const before = this.#records.length
			let grew = await this.#readMore()
			if (!grew.ok && this.#pointer !== undefined) {
				// The bytes before the cursor are not what was verified: the file was
				// rewritten in place. Read it again from the start.
				this.#restart()
				reset = true
				grew = await this.#readMore()
			}
			changed = changed || this.#records.length !== before
			if (this.#records.length !== before || reset) await this.#refold()
		}
		if (this.#records.length === 0 && info.size > 0 && this.#unverified) {
			throw new SessionUnreadableError(
				`The log of session ${this.#target.sessionId} cannot be verified from its first record, so nothing of it is shown.`,
			)
		}
		this.#size = info.size
		this.#identity = info.identity
		const status = await this.#status()
		const liveTurn =
			status.state === 'running' || status.state === 'waiting'
				? this.#fold.facts(this.#target.sessionId)?.activeTurn?.turnId
				: undefined
		return {
			status,
			messages: this.#messages,
			records: this.#records,
			changed,
			reset,
			...(liveTurn !== undefined ? { liveTurnId: liveTurn } : {}),
			...(this.#brokenAt !== undefined ? { brokenAt: this.#brokenAt } : {}),
		}
	}

	#restart(): void {
		this.#records = []
		this.#messages = []
		this.#pointer = undefined
		this.#fold = new ConversationFactsFold()
		this.#requests = new Map()
		this.#lastEnd = undefined
		this.#started = false
		this.#brokenAt = undefined
		this.#unverified = false
	}

	async #readMore(): Promise<{ ok: boolean }> {
		const walk = this.#log.read({
			mode: 'tolerant',
			...(this.#pointer !== undefined ? { after: this.#pointer } : {}),
		})
		let count = 0
		for (;;) {
			const step = await walk.next()
			if (step.done) {
				const summary = step.value
				if (!summary.intact && count === 0 && this.#pointer !== undefined) return { ok: false }
				this.#brokenAt = summary.intact ? undefined : summary.break?.seq
				this.#unverified = !summary.intact
				return { ok: true }
			}
			count += 1
			this.#apply(step.value.record)
			this.#pointer = step.value.pointer
		}
	}

	#apply(record: SessionRecord): void {
		if (!this.#started) {
			if (record.type !== 'session_started') {
				throw new SessionNotFoundError(
					`${this.#file} does not open with a session record, so it is not a session log.`,
				)
			}
			this.#assertOwned(record)
			this.#started = true
		}
		this.#records.push(record)
		this.#fold.apply(record)
		switch (record.type) {
			case 'decision_requested':
				this.#requests.set(record.decisionId, record.request as HITLDecisionRequest)
				break
			case 'decision_resolved':
			case 'decision_expired':
				this.#requests.delete(record.decisionId)
				break
			case 'turn_started':
				this.#lastEnd = undefined
				break
			case 'turn_completed': {
				const reason = record.stopReason
				const outcome: WatchOutcome =
					reason === undefined || reason === 'end_turn'
						? 'completed'
						: reason === 'cancelled'
							? 'cancelled'
							: 'stopped'
				this.#lastEnd = { outcome }
				break
			}
			case 'turn_failed':
				this.#lastEnd = { outcome: 'failed' }
				break
		}
	}

	#assertOwned(started: Extract<SessionRecord, { type: 'session_started' }>): void {
		if (
			started.projectId !== this.#target.projectId ||
			(started.tenantId !== undefined && started.tenantId !== this.#target.tenantId)
		) {
			throw new SessionNotOwnedError(
				`Session ${this.#target.sessionId} does not belong to this installation, so it is not shown.`,
			)
		}
	}

	async #refold(): Promise<void> {
		try {
			this.#messages = await foldSessionMessages(this.#records, {
				readSpill: (ref) => this.#log.readSpill(ref),
			})
		} catch {
			// A body that cannot be read back leaves the rows as they were; the
			// next append tries again.
		}
	}

	async #status(): Promise<WatchStatus> {
		const lease = await readSessionLease(this.#sessionDir).catch(() => null)
		const holderPid = holderPidOf(lease)
		// The lease runs for minutes after a killed host; on this machine the
		// holder's pid says sooner whether anybody is still there.
		const live =
			isLeaseLive(lease, this.#now()) && (holderPid === undefined || this.#alive(holderPid))
		const pid = holderPid !== undefined ? { holderPid } : {}
		const facts = this.#fold.facts(this.#target.sessionId)
		const active = facts?.activeTurn
		if (!active) {
			if (this.#lastEnd === undefined) {
				return { state: 'idle', sentence: 'No turn has run in this session yet.', ...pid }
			}
			const outcome = this.#lastEnd.outcome
			const how: Record<WatchOutcome, string> = {
				completed: 'The last turn finished.',
				failed: 'The last turn failed.',
				cancelled: 'The last turn was stopped by the person running it.',
				stopped: 'The last turn stopped before it finished its work.',
			}
			return { state: 'finished', outcome, sentence: how[outcome], ...pid }
		}
		const pending = [...this.#requests.values()].filter(
			(request) => request.turnId === active.turnId,
		)
		const request = pending.at(-1)
		const asking = request ? askingOf(request) : undefined
		const phrase = request
			? (ASK_PHRASES[request.type] ?? 'It is waiting for a person.')
			: undefined
		const paused = facts?.latestPause(active.turnId)
		const live_ = live && lease !== null
		if (active.paused || pending.length > 0) {
			if (!live_ && !active.paused) {
				return {
					state: 'interrupted',
					sentence: `The terminal running this session is gone while it waited to ${asking ?? 'be answered'}. Nothing can answer it now; resume it to go on.`,
					...(asking ? { asking } : {}),
					...pid,
				}
			}
			const kernel = paused?.explanation?.message ?? paused?.handoff?.reason ?? paused?.reason
			const where = live_
				? 'Answer it in the terminal that runs the session; this view cannot.'
				: 'No terminal runs it now; resume it to answer.'
			return {
				state: 'waiting',
				sentence: `${phrase ?? (kernel ? plainOneLine(kernel) : 'The turn is paused.')} ${where}`,
				...(asking ? { asking } : kernel ? { asking: plainOneLine(kernel) } : {}),
				...pid,
			}
		}
		if (!live_) {
			return {
				state: 'interrupted',
				sentence:
					'The process that ran this turn is gone and the turn never ended. Resume the session to go on.',
				...pid,
			}
		}
		return { state: 'running', sentence: 'A turn is running.', ...pid }
	}
}

// ─── finding sessions ──────────────────────────────────────────────────────

interface ProjectRef {
	readonly paths: SessionPaths
	readonly slug: string
	readonly projectId: ProjectId
	readonly cwd: string
}

/** The project documents under `root`, read-only. A folder whose document cannot be read is left out. */
async function readProjects(root: string): Promise<ProjectRef[]> {
	let slugs: string[]
	try {
		slugs = await readdir(join(root, 'projects'))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
	const out: ProjectRef[] = []
	for (const slug of slugs) {
		try {
			const raw = await readFile(join(root, 'projects', slug, 'project.json'), 'utf8')
			const doc = ProjectDocumentSchema.parse(JSON.parse(raw))
			out.push({
				paths: new SessionPaths({ home: root, slug }),
				slug,
				projectId: doc.projectId,
				cwd: doc.cwd,
			})
		} catch {
			// Not a project folder, or not readable: not ours to show.
		}
	}
	return out
}

async function rootLogIds(project: ProjectRef): Promise<SessionId[]> {
	let names: string[]
	try {
		names = await readdir(project.paths.projectDir())
	} catch {
		return []
	}
	const ids: SessionId[] = []
	for (const name of names) {
		if (!name.endsWith('.jsonl')) continue
		const raw = name.slice(0, -'.jsonl'.length)
		if (isEntityId(raw, 'session')) ids.push(asSessionId(raw))
	}
	return ids
}

export interface FindOptions {
	/** `NAMZU_HOME`. */
	readonly root: string
	readonly tenantId: TenantId
	/** The slug of the folder the command runs in; its sessions are matched and listed first. */
	readonly currentSlug?: string
}

function targetOf(project: ProjectRef, sessionId: SessionId, tenantId: TenantId): WatchTarget {
	return {
		paths: project.paths,
		projectId: project.projectId,
		sessionId,
		tenantId,
		folder: project.cwd,
	}
}

function ordered(projects: ProjectRef[], currentSlug: string | undefined): ProjectRef[] {
	return [...projects].sort(
		(a, b) => Number(b.slug === currentSlug) - Number(a.slug === currentSlug),
	)
}

/**
 * The session a person named: a whole id, or a prefix of one that picks a
 * single session. This folder is searched first, then the others of the same
 * installation. Only root sessions are addressed; a sub-agent's log is read
 * through its parent.
 */
export async function findSession(options: FindOptions, wanted: string): Promise<WatchTarget> {
	const key = wanted.trim().toLowerCase()
	if (key.length === 0)
		throw new SessionNotFoundError('Name a session: a whole id or the start of one.')
	const projects = ordered(await readProjects(options.root), options.currentSlug)
	const matches: WatchTarget[] = []
	for (const project of projects) {
		for (const id of await rootLogIds(project)) {
			if (id.toLowerCase() === key) return targetOf(project, id, options.tenantId)
			if (id.toLowerCase().startsWith(key)) {
				matches.push(targetOf(project, id, options.tenantId))
			}
		}
	}
	if (matches.length === 1) return matches[0] as WatchTarget
	if (matches.length === 0) {
		throw new SessionNotFoundError(`No session starts with "${wanted}" in this installation.`)
	}
	throw new SessionNotFoundError(
		`"${wanted}" starts ${matches.length} sessions: ${matches
			.slice(0, 5)
			.map((m) => m.sessionId)
			.join(', ')}${matches.length > 5 ? ', …' : ''}. Give more of the id.`,
	)
}

export interface RunningSession {
	readonly target: WatchTarget
	readonly title: string
	readonly state: 'running' | 'waiting'
	readonly updatedAt: string
	readonly holderPid?: number
	/** Started in the folder the command runs in. */
	readonly here: boolean
}

/**
 * The sessions with a turn in flight now: those whose writer lease is live.
 * This folder's first, then newest first. A session between turns holds no
 * lease and is not listed; it is still addressable by id.
 */
export async function listRunningSessions(
	options: FindOptions & {
		readonly now?: () => number
		readonly isProcessAlive?: (pid: number) => boolean
	},
): Promise<RunningSession[]> {
	const now = (options.now ?? Date.now)()
	const out: RunningSession[] = []
	for (const project of await readProjects(options.root)) {
		for (const id of await rootLogIds(project)) {
			const lease = await readSessionLease(project.paths.sessionDir({ sessionId: id })).catch(
				() => null,
			)
			if (!isLeaseLive(lease, now)) continue
			const holder = holderPidOf(lease)
			if (holder !== undefined && !(options.isProcessAlive ?? processIsAlive)(holder)) continue
			try {
				const fold = new ConversationFactsFold()
				const records: SessionRecord[] = []
				const log = DiskSessionLog.at(project.paths, { sessionId: id })
				const walk = log.read({ mode: 'tolerant' })
				for (;;) {
					const step = await walk.next()
					if (step.done) break
					fold.apply(step.value.record)
					records.push(step.value.record)
				}
				const facts = fold.facts(id)
				if (
					!facts ||
					facts.archived ||
					facts.started.projectId !== project.projectId ||
					(facts.started.tenantId !== undefined && facts.started.tenantId !== options.tenantId)
				)
					continue
				const messages = await foldSessionMessages(records, {
					readSpill: (ref) => log.readSpill(ref),
				}).catch(() => [] as Message[])
				const title =
					facts.title !== undefined &&
					facts.title.length > 0 &&
					(facts.named || facts.title !== 'Conversation')
						? facts.title
						: conversationTitle(messages)
				const active = facts.activeTurn
				const waiting =
					active !== undefined && (active.paused || facts.pendingDecisions(active.turnId).size > 0)
				const pid = holderPidOf(lease)
				out.push({
					target: targetOf(project, id, options.tenantId),
					title,
					state: waiting ? 'waiting' : 'running',
					updatedAt: facts.updatedAt,
					...(pid !== undefined ? { holderPid: pid } : {}),
					here: project.slug === options.currentSlug,
				})
			} catch {
				// A log that cannot be read is not offered.
			}
		}
	}
	return out.sort(
		(a, b) => Number(b.here) - Number(a.here) || b.updatedAt.localeCompare(a.updatedAt),
	)
}

/**
 * Conversation persistence for the CLI, built on the SDK's session log.
 *
 * Every conversation is one session: an append-only, hash-chained JSONL file
 * at `$NAMZU_HOME/projects/<slug>/<session-id>.jsonl`. The log is the source
 * of truth. The rebuildable index at `$NAMZU_HOME/index.sqlite` answers the
 * questions a list needs (which sessions this project has, which one a
 * desktop key names) and is refreshed from the log after every write here.
 *
 * The CLI writes only the records that happen outside a turn: the
 * `session_started` that creates a conversation, `session_updated` for its
 * title, archive flag and caller-side names, and the `compaction` record that
 * seeds a fork with the history it copied. Messages and turns are appended by
 * the kernel's turn recorder while `query()` runs, under the session lease.
 *
 * This is what powers `/resume`: list recent sessions, fold a chosen
 * session's messages, and keep chatting in it. The project is the canonical
 * checkout root, so every directory of one checkout shares its history.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
	DiskSessionGoalStore,
	DiskSessionLog,
	type Message,
	type ProjectId,
	type Session,
	type SessionGoalStore,
	type SessionId,
	type SessionIndex,
	type SessionLease,
	SessionPaths,
	type SessionRecord,
	type SessionRecordDraft,
	type SessionStartedRecord,
	type TenantId,
	type TopicId,
	type UserMessage,
	asSessionId,
	asTopicId,
	ensureProject,
	foldSessionMessages,
	generateSessionId,
	isEntityId,
	openSessionIndex,
	readSessionLog,
} from '@namzu/sdk'
import { resolveNamzuHome } from '../state/home.js'
import { loadIdentity } from '../state/identity.js'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'
import { cliProjectRoot } from '../state/project.js'

/**
 * The part of the kernel's `SessionStore` contract the CLI still reads: one
 * session by id, scoped to the tenant. Derived from the session's log, so it
 * can never disagree with it. The goal store takes this for its ownership
 * check.
 */
export interface CliSessionCatalog {
	getSession(sessionId: SessionId, tenantId: TenantId): Promise<Session | null>
}

export interface CliSessions {
	/** Absolute `NAMZU_HOME`. */
	readonly root: string
	/** The project's layout under `root`. */
	readonly paths: SessionPaths
	/** The project's directory name under `projects/`. */
	readonly slug: string
	/** The canonical checkout root the project stands for. */
	readonly projectRoot: string
	readonly projectId: ProjectId
	readonly topicId: TopicId
	readonly tenantId: TenantId
	/** The rebuildable index over every session log under `root`. */
	readonly index: SessionIndex
	/** Sessions by id, read from their logs. */
	readonly store: CliSessionCatalog
	/** Durable completion goal owned by each conversation Session. */
	readonly goals: SessionGoalStore
}

/** Persisted conversation ownership and history; no goal or UI sidecars are needed for retrieval. */
export type ConversationContext = Pick<
	CliSessions,
	'root' | 'paths' | 'slug' | 'projectId' | 'topicId' | 'tenantId' | 'store'
>

export interface RecentConversation {
	readonly id: SessionId
	readonly title: string
	/**
	 * Whether a person chose that title, or it was taken from the first thing
	 * they typed.
	 *
	 * Surfaced rather than inferred, because the two read identically in a
	 * list and mean different things: a derived title changes meaning as a
	 * conversation moves on from its opening question, and a named one does
	 * not. `/resume` is the place that difference matters.
	 */
	readonly named: boolean
	readonly updatedAt: string
	readonly count: number
	readonly preview?: string
}

export interface OpenSessionsOptions {
	/** Exact `NAMZU_HOME`; test/embedding seam. */
	readonly stateRoot?: string
	/** OS-home and environment seams used by the application-home resolver. */
	readonly home?: string
	readonly env?: NodeJS.ProcessEnv
	/** Index backend; `auto` (the default) uses SQLite when `node:sqlite` loads. */
	readonly indexBackend?: 'auto' | 'sqlite' | 'scan'
}

/** Who created a conversation, as its `session_started.agent` records it. */
const CLI_AGENT = { id: 'namzu-cli', name: 'Namzu' } as const

/** How long a write outside a turn waits for a lease another writer holds. */
const LEASE_WAIT_MS = 5_000
const LEASE_POLL_MS = 25
const LEASE_TTL_MS = 30_000

/**
 * Open (or initialize) the working directory's project: `projects/<slug>/`
 * with its `project.json`, the installation's tenant, and the index.
 *
 * The project is the nearest checkout root (a `.git` file or directory), so
 * worktrees and nested repositories keep distinct history while every
 * directory of one checkout shares it. Tool cwd is unchanged.
 */
export async function openSessions(
	cwd: string,
	options: OpenSessionsOptions = {},
): Promise<CliSessions> {
	const workingDirectory = await realpath(resolve(cwd))
	const root = resolve(
		options.stateRoot ??
			resolveNamzuHome({
				...(options.home !== undefined ? { home: options.home } : {}),
				...(options.env !== undefined ? { env: options.env } : {}),
			}),
	)
	mkdirSync(root, { recursive: true })
	// The installation owns the tenant; the canonical checkout owns the Project.
	const tenantId = loadIdentity(root).tenantId
	const projectsDir = ensurePrivateStateDirectory(root, 'projects')
	const project = await ensureProject({ home: root, cwd: cliProjectRoot(workingDirectory) })
	ensurePrivateStateDirectory(projectsDir, project.slug)
	const paths = new SessionPaths({ home: root, slug: project.slug })
	const index = await openSessionIndex({
		home: root,
		...(options.indexBackend ? { backend: options.indexBackend } : {}),
	})
	const partial = {
		root,
		paths,
		slug: project.slug,
		projectRoot: project.cwd,
		projectId: project.projectId,
		topicId: topicIdFor(project.projectId),
		tenantId,
		index,
	}
	const store: CliSessionCatalog = {
		getSession: (sessionId, tenant) => readSessionEntity(partial, sessionId, tenant),
	}
	return {
		...partial,
		store,
		goals: new DiskSessionGoalStore({ rootDir: paths.projectDir(), sessions: store }),
	}
}

/** Release the index's database handle. Idempotent. */
export function closeSessions(s: Pick<CliSessions, 'index'>): void {
	try {
		s.index.close()
	} catch {
		// Already closed.
	}
}

/** One stable CLI topic per logical workspace, without an extra binding file. */
function topicIdFor(projectId: ProjectId): TopicId {
	const digest = createHash('sha256').update(`namzu:cli-topic:${projectId}`).digest('hex')
	return asTopicId(
		`${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
	)
}

// ─── the log ──────────────────────────────────────────────────────────────

/** The file a root conversation's log lives in. */
export function conversationLogPath(s: Pick<CliSessions, 'paths'>, sessionId: SessionId): string {
	return s.paths.sessionLog({ sessionId })
}

/** A writer handle on one conversation's log. */
export function openConversationLog(
	s: Pick<CliSessions, 'paths'>,
	sessionId: SessionId,
): DiskSessionLog {
	return DiskSessionLog.at(s.paths, { sessionId })
}

function holderName(): string {
	return `namzu-cli:${process.pid}:${randomUUID()}`
}

/**
 * Take a conversation's writer lease, waiting briefly for another writer.
 *
 * A turn holds the lease while it runs, so a write between turns only ever
 * waits for a turn that is settling. One that is still running when the wait
 * ends is refused by name rather than waited on indefinitely.
 */
async function claimLease(log: DiskSessionLog, op: string): Promise<SessionLease> {
	const deadline = Date.now() + LEASE_WAIT_MS
	const holder = holderName()
	for (;;) {
		const lease = await log.claim({ holder, ttlMs: LEASE_TTL_MS })
		if (lease) return lease
		if (Date.now() >= deadline) {
			throw new Error(
				`Conversation ${log.sessionId} is busy: another writer holds it — ${op} rejected. Wait for its turn to finish and try again.`,
			)
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, LEASE_POLL_MS))
	}
}

/** Append records outside any turn, under a lease taken for just these records. */
async function appendOutsideTurn(
	s: Pick<CliSessions, 'paths' | 'slug' | 'index'>,
	sessionId: SessionId,
	drafts: readonly SessionRecordDraft[],
	op: string,
): Promise<void> {
	const log = openConversationLog(s, sessionId)
	const lease = await claimLease(log, op)
	try {
		for (const draft of drafts) await log.append(lease, draft)
	} finally {
		await log.release(lease)
	}
	await refreshIndex(s, sessionId)
}

/** Bring the index's row for one conversation up to date with its log. */
export async function refreshIndex(
	s: Pick<CliSessions, 'paths' | 'slug' | 'index'>,
	sessionId: SessionId,
): Promise<void> {
	await s.index.refresh({ slug: s.slug, logPath: conversationLogPath(s, sessionId), sessionId })
}

/** What one conversation's log says about it, outside its messages. */
export interface ConversationFacts {
	readonly sessionId: SessionId
	readonly started: SessionStartedRecord
	/** The latest `session_updated.title`; empty or absent means derived. */
	readonly title?: string
	readonly named: boolean
	readonly archived: boolean
	readonly createdAt: string
	readonly updatedAt: string
	/** The session's open turn, if any, and whether it is parked. */
	readonly activeTurn?: { readonly turnId: string; readonly paused: boolean }
	readonly records: readonly SessionRecord[]
}

/**
 * Read one conversation's log, or `null` when there is none.
 *
 * Strict by default: a log whose chain is broken is not something to resume
 * or fork. A list passes `tolerant` and reads what precedes the break.
 */
export async function readConversationFacts(
	s: Pick<CliSessions, 'paths'>,
	sessionId: SessionId,
	mode: 'strict' | 'tolerant' = 'strict',
): Promise<ConversationFacts | null> {
	const read = await readSessionLog(conversationLogPath(s, sessionId), { mode, sessionId })
	const records = read.entries.map((entry) => entry.record)
	const first = records[0]
	if (first === undefined || first.type !== 'session_started') return null
	let title: string | undefined
	let named = false
	let archived = false
	let active: { turnId: string; paused: boolean } | undefined
	for (const record of records) {
		switch (record.type) {
			case 'session_updated':
				if (record.title !== undefined) {
					title = record.title
					named = record.titleSource === 'named' && record.title.length > 0
				}
				if (record.archived !== undefined) archived = record.archived
				break
			case 'turn_started':
				active = { turnId: record.turnId, paused: false }
				break
			case 'turn_paused':
				if (active?.turnId === record.turnId) active = { ...active, paused: true }
				break
			case 'turn_resuming':
				if (active?.turnId === record.turnId) active = { ...active, paused: false }
				break
			case 'turn_completed':
			case 'turn_failed':
				if (active?.turnId === record.turnId) active = undefined
				break
		}
	}
	return {
		sessionId,
		started: first,
		...(title !== undefined ? { title } : {}),
		named,
		archived,
		createdAt: first.ts,
		updatedAt: records.at(-1)?.ts ?? first.ts,
		...(active ? { activeTurn: active } : {}),
		records,
	}
}

/** The folded conversation a log's records describe, spills read back. */
async function foldConversation(
	s: Pick<CliSessions, 'paths'>,
	sessionId: SessionId,
	records: readonly SessionRecord[],
): Promise<Message[]> {
	const log = openConversationLog(s, sessionId)
	return await foldSessionMessages(records, { readSpill: (ref) => log.readSpill(ref) })
}

async function readSessionEntity(
	s: Pick<CliSessions, 'paths' | 'projectId'>,
	sessionId: SessionId,
	tenantId: TenantId,
): Promise<Session | null> {
	if (!isEntityId(sessionId, 'session')) return null
	const facts = await readConversationFacts(s, sessionId, 'tolerant')
	if (!facts) return null
	const recordedTenant = facts.started.tenantId
	if (recordedTenant !== undefined && recordedTenant !== tenantId) return null
	return {
		id: sessionId,
		topicId: facts.started.topicId ?? topicIdFor(facts.started.projectId),
		projectId: facts.started.projectId,
		tenantId,
		status: facts.archived ? 'archived' : 'idle',
		currentActor: null,
		previousActors: [],
		workspaceId: null,
		ownerVersion: 0,
		createdAt: new Date(facts.createdAt),
		updatedAt: new Date(facts.updatedAt),
	}
}

// ─── conversations ────────────────────────────────────────────────────────

export interface StartConversationOptions {
	/** The id to create the conversation under; minted when absent. */
	readonly id?: SessionId
	/** A caller-side name for the conversation (a desktop host's session key). */
	readonly origin?: SessionStartedRecord['origin']
}

/**
 * Start a fresh conversation; returns its session id.
 *
 * Writes the log's first record, `session_started`, naming the project, the
 * tenant and the CLI topic. An id that already has a log is refused: two
 * conversations never share one.
 */
export async function startConversation(
	s: Pick<
		CliSessions,
		'paths' | 'slug' | 'index' | 'projectId' | 'topicId' | 'tenantId' | 'projectRoot'
	>,
	idOrOptions?: SessionId | StartConversationOptions,
): Promise<SessionId> {
	const options: StartConversationOptions =
		typeof idOrOptions === 'string' ? { id: idOrOptions } : (idOrOptions ?? {})
	const id = options.id ?? generateSessionId()
	const log = openConversationLog(s, id)
	const lease = await claimLease(log, 'start conversation')
	try {
		if ((await log.head()) !== null) {
			throw new Error(`Conversation ${id} already exists — start conversation rejected.`)
		}
		await log.append(lease, {
			type: 'session_started',
			projectId: s.projectId,
			tenantId: s.tenantId,
			topicId: s.topicId,
			cwd: s.projectRoot,
			agent: { ...CLI_AGENT },
			origin: options.origin ?? { protocol: 'cli' },
		})
	} finally {
		await log.release(lease)
	}
	await refreshIndex(s, id)
	return id
}

/** The external id a desktop key is filed under: scoped to the project, like the map it replaces. */
function desktopExternalId(projectId: ProjectId, key: string): string {
	return JSON.stringify([projectId, key])
}

/**
 * Resolve (creating if needed) the conversation bound to an embedder's
 * session key. The binding is the conversation's own `session_started.origin`,
 * so a later turn or history load with the same key reuses it, and an index
 * rebuild finds it again.
 */
export async function resolveConversation(s: CliSessions, key: string): Promise<SessionId> {
	const existing = await findMappedConversation(s, key)
	if (existing) {
		await requireWritableConversation(s, existing, 'continue keyed conversation')
		return existing
	}
	const id = await startConversation(s, {
		origin: { protocol: 'desktop', externalSessionId: desktopExternalId(s.projectId, key) },
	})
	// Another process may have claimed the key while this one was creating. The
	// earliest claim wins the name; a loser archives its empty conversation so it
	// never shows up in `/resume` as a second, indistinguishable row.
	const winner = await findMappedConversation(s, key)
	if (winner && winner !== id) {
		await archiveConversation(s, id).catch(() => undefined)
		await requireWritableConversation(s, winner, 'continue keyed conversation')
		return winner
	}
	return id
}

/** Read an external-session binding without creating or widening its scope. */
export async function findMappedConversation(
	s: CliSessions,
	key: string,
): Promise<SessionId | null> {
	const target = await s.index.resolveExternal(
		'desktop',
		'session',
		desktopExternalId(s.projectId, key),
	)
	if (!target) return null
	const facts = await readConversationFacts(s, target.sessionId, 'tolerant')
	return facts?.started.projectId === s.projectId ? target.sessionId : null
}

/**
 * Resolve a conversation through this project.
 *
 * A session id names a file under this project's directory, so a log that
 * exists proves the conversation is this project's; the project id it
 * recorded must also agree, and so must the tenant.
 */
async function requireConversationInScope(
	s: ConversationContext,
	sessionId: SessionId,
	op: string,
): Promise<ConversationFacts> {
	const facts = await readConversationFacts(s, sessionId)
	if (!facts) {
		throw new Error(`Conversation ${sessionId} was not found — ${op} rejected`)
	}
	if (
		facts.started.projectId !== s.projectId ||
		(facts.started.tenantId !== undefined && facts.started.tenantId !== s.tenantId)
	) {
		throw new Error(`Conversation ${sessionId} does not belong to this workspace — ${op} rejected`)
	}
	return facts
}

/**
 * Sequential admission gate for a turn or conversation mutation: the target
 * exists in this project and is not archived. It is not a cross-process
 * transaction; the session lease is what serialises writers.
 */
export async function requireWritableConversation(
	s: ConversationContext,
	sessionId: SessionId,
	op = 'continue conversation',
): Promise<void> {
	const facts = await requireConversationInScope(s, sessionId, op)
	if (facts.archived) {
		throw new Error(
			`Conversation ${sessionId} is archived and read-only — ${op} rejected. Its history remains available for inspection.`,
		)
	}
}

/**
 * Turn the conversation into a read-only tombstone with `session_updated
 * {archived: true}`. History remains readable, while `/resume`, later turns
 * and forks reject through {@link requireWritableConversation}.
 */
export async function archiveConversation(s: CliSessions, sessionId: SessionId): Promise<void> {
	const facts = await requireConversationInScope(s, sessionId, 'archive conversation')
	if (facts.archived) {
		throw new Error(`Conversation ${sessionId} is already archived.`)
	}
	await appendOutsideTurn(
		s,
		sessionId,
		[{ type: 'session_updated', archived: true }],
		'archive conversation',
	)
}

/** Load a conversation's folded message history. */
export async function loadConversation(
	s: ConversationContext,
	sessionId: SessionId,
): Promise<Message[]> {
	const facts = await requireConversationInScope(s, sessionId, 'load conversation history')
	return await foldConversation(s, sessionId, facts.records)
}

/**
 * Load one conversation for a new model turn.
 *
 * Reading an archived conversation remains legitimate — `history` and export
 * are inspection surfaces — but resuming it would turn a tombstone back into a
 * live writer without a restore operation.
 */
export async function loadResumableConversation(
	s: ConversationContext,
	sessionId: string,
): Promise<Message[]> {
	const checked = asSessionId(sessionId)
	await requireWritableConversation(s, checked, 'resume conversation')
	return await loadConversation(s, checked)
}

/** The open turn of a conversation, if it has one: `paused` when it is parked. */
export async function activeConversationTurn(
	s: ConversationContext,
	sessionId: SessionId,
): Promise<ConversationFacts['activeTurn'] | undefined> {
	return (await requireConversationInScope(s, sessionId, 'inspect conversation')).activeTurn
}

/** Recent non-empty conversations, newest first — for the `/resume` list. */
export async function listRecent(s: CliSessions, limit = 20): Promise<RecentConversation[]> {
	const rows = await s.index.listSessions({ slug: s.slug, rootsOnly: true, includeArchived: false })
	const out: RecentConversation[] = []
	for (const row of rows) {
		if (row.projectId !== s.projectId || row.archived) continue
		let facts: ConversationFacts | null
		let messages: Message[]
		try {
			facts = await readConversationFacts(s, row.id, 'tolerant')
			if (!facts || facts.archived || facts.started.projectId !== s.projectId) continue
			messages = await foldConversation(s, row.id, facts.records)
		} catch {
			// A log this process cannot read is not a row a person can resume.
			continue
		}
		if (messages.length === 0) continue
		const everything = recordedMessages(facts.records)
		out.push({
			id: row.id,
			title:
				facts.title !== undefined &&
				facts.title.length > 0 &&
				(facts.named || facts.title !== 'Conversation')
					? facts.title
					: conversationTitle(everything),
			preview: [...everything]
				.reverse()
				.find(
					(message): message is UserMessage =>
						message.role === 'user' && message.source === undefined,
				)
				?.content.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 240),
			named: facts.named,
			updatedAt: facts.updatedAt,
			count: messages.length,
		})
	}
	return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
}

/** The name a person gave this conversation, or `undefined`. */
export async function titleOf(
	s: ConversationContext,
	sessionId: SessionId,
): Promise<string | undefined> {
	const facts = await readConversationFacts(s, sessionId, 'tolerant')
	return facts?.named ? facts.title : undefined
}

/**
 * Name a conversation, or with an empty name, take the name away.
 *
 * Recorded as `session_updated{title, titleSource: 'named'}`; clearing records
 * an empty derived title, so the list derives one from the first message
 * again rather than showing a blank row.
 */
export async function setTitle(s: CliSessions, sessionId: SessionId, title: string): Promise<void> {
	await requireConversationInScope(s, sessionId, 'name conversation')
	const trimmed = title.trim()
	await appendOutsideTurn(
		s,
		sessionId,
		[
			trimmed === ''
				? { type: 'session_updated', title: '', titleSource: 'derived' }
				: { type: 'session_updated', title: trimmed, titleSource: 'named' },
		],
		'name conversation',
	)
}

/**
 * Seed a conversation that has no turns yet with a history, as one
 * `compaction` record outside any turn: the fold starts from its summary, so
 * the new conversation's context is exactly `messages`. Used by forks.
 */
export async function seedConversationHistory(
	s: Pick<CliSessions, 'paths' | 'slug' | 'index'>,
	sessionId: SessionId,
	messages: readonly Message[],
	strategy = 'fork',
): Promise<void> {
	if (messages.length === 0) return
	await appendOutsideTurn(
		s,
		sessionId,
		[
			{
				type: 'compaction',
				compactionId: randomUUID(),
				strategy,
				trigger: 'manual',
				replacesSeqRange: [1, 1],
				summary: [...messages],
				keptMessageIds: [],
				tokensBefore: 0,
				tokensAfter: 0,
			},
		],
		'seed conversation history',
	)
}

/**
 * Continue in a copy, leaving the original where it is.
 *
 * The copy is a real Session with the transcript written into it, not a
 * pointer: the two diverge from here, and a pointer would make the original's
 * later turns appear in the fork.
 *
 * **The fork is always named, and that is the load-bearing part.** Both
 * conversations start with the same first message, so both DERIVE the same
 * title — and `/resume` would show two rows a person cannot tell apart. The
 * name is taken from the source's own, so a fork of a fork stays readable, and
 * it is numbered against the names already in use.
 */
export async function forkConversation(
	s: CliSessions,
	sourceId: SessionId,
): Promise<{ id: SessionId; title: string; copied: number }> {
	await requireWritableConversation(s, sourceId, 'fork conversation')
	const messages = await loadConversation(s, sourceId)
	if (messages.length === 0) {
		// Refused rather than served. A fork of nothing is an empty session
		// that shows up in `/resume` forever and answers no question.
		throw new Error('There is nothing to fork yet — this conversation has no messages.')
	}
	const { id, title } = await writeFork(s, sourceId, messages, messages)
	return { id, title, copied: messages.length }
}

export interface ForkBeforeUserResult {
	readonly id: SessionId
	readonly title: string
	/** Exact durable prefix copied into the fork. */
	readonly messages: readonly Message[]
	/** Exact durable user message the caller selected and may reopen. */
	readonly selected: UserMessage
}

/**
 * Fork immediately before one durable user message.
 *
 * `userOrdinal` is zero-based among user messages, not among every message.
 * The expected message is a compare-and-swap guard: a picker selects from an
 * in-memory history, then this helper reloads disk. If another write changed
 * that position, it refuses BEFORE creating a session instead of branching at
 * a boundary the operator did not select.
 *
 * An empty prefix is valid. Editing the first prompt creates an empty branch
 * and restores that prompt to the composer.
 */
export async function forkConversationBeforeUser(
	s: CliSessions,
	sourceId: SessionId,
	userOrdinal: number,
	expected: UserMessage,
): Promise<ForkBeforeUserResult> {
	if (!Number.isInteger(userOrdinal) || userOrdinal < 0) {
		throw new Error('The selected user-message position is invalid.')
	}

	await requireWritableConversation(s, sourceId, 'fork conversation before a prompt')
	const messages = await loadConversation(s, sourceId)
	let seen = -1
	const messageIndex = messages.findIndex((message) => {
		if (message.role !== 'user') return false
		seen += 1
		return seen === userOrdinal
	})
	const selected = messages[messageIndex]
	if (messageIndex < 0 || selected?.role !== 'user') {
		throw new Error('The selected user message no longer exists in this conversation.')
	}
	if (!isDeepStrictEqual(selected, expected)) {
		throw new Error(
			'The conversation changed after the prompt was selected. Nothing was forked; open the editor again from the current history.',
		)
	}

	const prefix = messages.slice(0, messageIndex)
	const { id, title } = await writeFork(s, sourceId, messages, prefix)
	return { id, title, messages: prefix, selected }
}

/** Create, seed and name one fork after every boundary decision has been validated. */
async function writeFork(
	s: CliSessions,
	sourceId: SessionId,
	sourceMessages: readonly Message[],
	copiedMessages: readonly Message[],
): Promise<{ id: SessionId; title: string }> {
	const sourceFacts = await readConversationFacts(s, sourceId, 'tolerant')
	const source =
		sourceFacts?.title !== undefined && sourceFacts.title.length > 0
			? sourceFacts.title
			: conversationTitle(sourceFacts ? recordedMessages(sourceFacts.records) : sourceMessages)
	const id = await startConversation(s)
	await seedConversationHistory(s, id, copiedMessages)
	const copiedBack = await loadConversation(s, id)
	if (!isDeepStrictEqual(copiedBack, [...copiedMessages])) {
		throw new Error(`The forked conversation did not preserve its exact copied history (${id}).`)
	}
	const title = nextForkName(await takenTitles(s), source)
	await setTitle(s, id, title)
	return { id, title }
}

/** Every title in use among this project's conversations, keyed by session id. */
async function takenTitles(s: CliSessions): Promise<Record<string, string>> {
	const taken: Record<string, string> = {}
	for (const row of await s.index.listSessions({ slug: s.slug, rootsOnly: true })) {
		if (row.title !== undefined && row.title.length > 0) taken[row.id] = row.title
	}
	return taken
}

/**
 * Every message the log ever recorded, in order: a fork's seeded history and
 * each `message` record, before any compaction or replacement folds them.
 *
 * A derived title and the list preview are read from this rather than from
 * the fold, so compacting a conversation away from its opening question does
 * not rename it: the opening message is still in the log.
 */
function recordedMessages(records: readonly SessionRecord[]): Message[] {
	const out: Message[] = []
	for (const record of records) {
		if (record.type === 'message') out.push(record.content)
		else if (record.type === 'compaction' && Array.isArray(record.summary)) {
			if (record.strategy === 'fork') out.push(...record.summary)
		}
	}
	return out
}

/**
 * `X (fork)`, then `X (fork 2)`, `X (fork 3)`.
 *
 * Numbered against the names in use rather than against a count of forks,
 * because a name that was removed frees its number and a fork that was renamed
 * never held one.
 */
export function nextForkName(taken: Record<string, string>, source: string): string {
	const used = new Set(Object.values(taken))
	const first = `${source} (fork)`
	if (!used.has(first)) return first
	for (let n = 2; n < 1000; n += 1) {
		const candidate = `${source} (fork ${n})`
		if (!used.has(candidate)) return candidate
	}
	// A thousand forks of one conversation is not a case worth a cleverer
	// answer, and a name that repeats is better than a refusal here.
	return `${source} (fork)`
}

export function conversationTitle(messages: readonly Message[]): string {
	const firstHuman = messages.find(
		(message) => message.role === 'user' && message.source === undefined,
	)
	const firstGoal = messages.find(
		(message) => message.role === 'user' && message.source?.type === 'goal-round',
	)
	const raw =
		firstHuman?.role === 'user'
			? firstHuman.content
			: firstGoal?.role === 'user' && firstGoal.source?.type === 'goal-round'
				? firstGoal.source.objective
				: 'Conversation'
	const text = raw.replace(/\s+/g, ' ').trim()
	return text.length > 60 ? `${text.slice(0, 59)}…` : text || 'Conversation'
}

/** The project directory name, for messages that point a person at it. */
export function projectLabel(s: Pick<CliSessions, 'projectRoot'>): string {
	return basename(s.projectRoot) || s.projectRoot
}

/** Where a conversation's per-session files live (`<session-id>/`). */
export function conversationDir(s: Pick<CliSessions, 'paths'>, sessionId: SessionId): string {
	return s.paths.sessionDir({ sessionId })
}

/** The project's directory under `NAMZU_HOME` (`projects/<slug>/`). */
export function projectDir(s: Pick<CliSessions, 'root' | 'slug'>): string {
	return join(s.root, 'projects', s.slug)
}

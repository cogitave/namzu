/**
 * Conversation persistence for the TUI, built on the SDK's session
 * hierarchy (`DiskSessionStore`) — no parallel store. Each cwd is one
 * "project" (a `cli.json` pointer keeps its id stable across launches),
 * every conversation is a Session under a fixed CLI thread, and the
 * conversation's messages are appended to the session as turns complete.
 *
 * This is what powers `/resume`: list recent sessions, load a chosen
 * session's messages, and keep chatting in it. The session store roots at
 * `<cwd>/.namzu`, the same root `query()` writes its runs under, so a
 * session's `session.json` and its `runs/` live in one place.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
	DiskSessionStore,
	type Message,
	type ProjectId,
	type SessionId,
	type TenantId,
	type TopicId,
	UNKNOWN_TENANT_ID,
	type UserMessage,
	asProjectId,
	asSessionId,
	asTopicId,
	requireOpenProject,
} from '@namzu/sdk'
import {
	type ConversationLineageTurn,
	type ConversationOrigin,
	type ConversationTurnReference,
	DiskConversationEvidence,
} from './turn-evidence.js'

// `UNKNOWN_TENANT_ID` is already a `TenantId`; the assertion this replaced
// re-stated a type the constant carries.
const TENANT: TenantId = UNKNOWN_TENANT_ID
const THREAD = asTopicId('top_namzu-cli')

export interface CliSessions {
	readonly store: DiskSessionStore
	readonly projectId: ProjectId
	readonly topicId: TopicId
	readonly tenantId: TenantId
	/** Absolute path of the cwd's `.namzu` root (where pointers live). */
	readonly root: string
	/**
	 * CLI-only turn/run correlation. Optional for embedded test doubles and
	 * pre-feature hosts; {@link openSessions} always supplies it.
	 */
	readonly turnEvidence?: DiskConversationEvidence
}

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
}

/**
 * Open (or initialize) the cwd's CLI project. Returns the handle used by
 * the other helpers. Throws only on unexpected store errors; callers treat
 * failures as "persistence unavailable" and run without it.
 */
export async function openSessions(cwd: string): Promise<CliSessions> {
	const root = join(cwd, '.namzu')
	const store = new DiskSessionStore({ rootDir: root })
	const pointerPath = join(root, 'cli.json')

	let projectId: ProjectId | undefined
	try {
		const ptr = JSON.parse(readFileSync(pointerPath, 'utf8')) as { projectId?: string }
		// Prefix-checked, and a bad pointer is treated exactly like a stale one:
		// the next lines already drop a projectId whose directory is gone, so a
		// hand-edited `cli.json` takes the same path instead of carrying a
		// non-id into a store lookup.
		if (typeof ptr.projectId === 'string' && ptr.projectId.startsWith('prj_')) {
			projectId = asProjectId(ptr.projectId)
		}
	} catch {
		// no pointer yet
	}
	if (projectId && !(await store.getProject(projectId, TENANT))) {
		projectId = undefined // pointer is stale (dir wiped)
	}
	if (!projectId) {
		const project = await store.createProject({ tenantId: TENANT, name: 'namzu CLI' }, TENANT)
		projectId = project.id
		mkdirSync(root, { recursive: true })
		writeFileSync(pointerPath, `${JSON.stringify({ projectId }, null, 2)}\n`, { mode: 0o600 })
	}
	return {
		store,
		projectId,
		topicId: THREAD,
		tenantId: TENANT,
		root,
		turnEvidence: new DiskConversationEvidence({ root, projectId }),
	}
}

// Maps an embedder's own session key (e.g. a desktop host's uuid) to a
// namzu conversation id, so reopening that session resumes the same
// transcript. Kept as a small JSON pointer beside cli.json.
const DESKTOP_MAP = 'desktop-sessions.json'

function readDesktopMap(root: string): Record<string, string> {
	try {
		const raw = JSON.parse(readFileSync(join(root, DESKTOP_MAP), 'utf8'))
		return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {}
	} catch {
		return {}
	}
}

/**
 * Resolve (creating if needed) the namzu conversation bound to an embedder's
 * session key. The mapping persists so a later turn / a history load with the
 * same key reuses the same conversation. Falls back to a fresh conversation if
 * the mapped id was wiped.
 */
export async function resolveConversation(s: CliSessions, key: string): Promise<SessionId> {
	const map = readDesktopMap(s.root)
	const existing = map[key]
	// Same treatment as the project pointer above: a mapped id that is not an
	// id is indistinguishable from one whose session was wiped, and this
	// function already knows what to do about that — mint a fresh one.
	if (existing?.startsWith('ses_')) {
		const mapped = asSessionId(existing)
		if (await s.store.getSession(mapped, s.tenantId)) return mapped
	}
	const id = await startConversation(s)
	map[key] = id
	mkdirSync(s.root, { recursive: true })
	writeFileSync(join(s.root, DESKTOP_MAP), `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 })
	return id
}

/**
 * Start a fresh conversation; returns its session id.
 *
 * The workspace gate runs HERE rather than being assumed from the caller,
 * because this is a store call and a store deliberately holds no view of
 * workspace status — the SDK's own note says a direct store caller bypasses
 * the invariant, and this was such a caller.
 *
 * It is not ceremony, and the difference is `openSessions` above: the project
 * id is read back out of `.namzu/cli.json` and a new project is created only
 * when the pointer is missing or stale. So on every run after the first, this
 * attaches a session to a project it did NOT just create — one an owner may
 * since have closed. A freshly created project is always open, which is why
 * the first run could never have shown this.
 */
export async function startConversation(s: CliSessions): Promise<SessionId> {
	const id = await createConversation(s)
	await s.turnEvidence?.recordOrigin(id, { kind: 'new' })
	return id
}

async function createConversation(s: CliSessions): Promise<SessionId> {
	await requireOpenProject(s.store, s.projectId, s.tenantId, 'cli-session')
	const session = await s.store.createSession(
		{ topicId: s.topicId, projectId: s.projectId, currentActor: null },
		s.tenantId,
	)
	return session.id
}

/** Append messages (in order) to a conversation. */
export async function appendMessages(
	s: CliSessions,
	sessionId: SessionId,
	messages: readonly Message[],
): Promise<void> {
	for (const m of messages) {
		await s.store.appendMessage(sessionId, m, s.tenantId)
	}
}

/**
 * Replace the durable conversation view with a compacted history.
 *
 * The store writes this as one replacement record inside its append-only log,
 * so a crash cannot expose the first half of a compacted conversation. Before
 * replacing, pin the derived title without calling it a chosen name: the
 * opening user message may be among the turns compacted away, and `/resume`
 * must neither rename nor quote the conversation as a side effect of making
 * it smaller.
 */
export async function replaceConversation(
	s: CliSessions,
	sessionId: SessionId,
	messages: readonly Message[],
): Promise<void> {
	const existing = await loadConversation(s, sessionId)
	const titles = readTitles(s.root)
	if (titles[sessionId as string] === undefined) {
		titles[sessionId as string] = { title: conversationTitle(existing), named: false }
		writeTitles(s.root, titles)
	}
	await s.store.replaceMessages(sessionId, messages, s.tenantId)
}

/** Load a conversation's full message history. */
export async function loadConversation(s: CliSessions, sessionId: SessionId): Promise<Message[]> {
	return [...(await s.store.loadMessages(sessionId, s.tenantId))]
}

/** Recent non-empty conversations, newest first — for the `/resume` list. */
export async function listRecent(s: CliSessions, limit = 20): Promise<RecentConversation[]> {
	const sessions = await s.store.listSessionsByTopic(s.topicId, s.tenantId)
	const titles = readTitles(s.root)
	const out: RecentConversation[] = []
	for (const sess of sessions) {
		const messages = await s.store.loadMessages(sess.id, s.tenantId)
		if (messages.length === 0) continue
		const stored = titles[sess.id as string]
		out.push({
			id: sess.id,
			title: stored?.title ?? conversationTitle(messages),
			named: stored?.named ?? false,
			updatedAt: toIso(sess.updatedAt),
			count: messages.length,
		})
	}
	return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
}

/**
 * Conversation titles that must survive their opening message, in a file
 * beside the sessions. `named` distinguishes a person's choice from a derived
 * title pinned before compaction removes the message it came from.
 *
 * A sidecar rather than a field on the SDK's `Session`. Naming a conversation
 * is an operator-application concern: the kernel has no view that lists them
 * and nothing in it would read the name. Putting it in the entity would widen
 * a store interface every host implements, to carry a string only this package
 * writes and only this package displays.
 *
 * The cost is that the two can disagree — a session deleted outside this
 * process leaves its name behind. That is why nothing here treats the file as
 * a list of sessions: it is consulted BY id, from a list the store produced,
 * so a stale entry is never reachable and never has to be reconciled.
 */
const TITLES_FILE = 'titles.json'

function titlesPath(root: string): string {
	return join(root, TITLES_FILE)
}

interface StoredTitle {
	readonly title: string
	readonly named: boolean
}

function readTitles(root: string): Record<string, StoredTitle> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(titlesPath(root), 'utf-8'))
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
		// Filtered rather than trusted. This file is on disk where a person can
		// edit it, and a malformed value reaching the renderer as a title is a
		// crash in a list nobody could then get out of. Strings are the v1 shape:
		// every one was written by `/title`, so each remains a chosen name.
		const titles: Record<string, StoredTitle> = {}
		for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === 'string') {
				titles[id] = { title: value, named: true }
				continue
			}
			if (typeof value !== 'object' || value === null) continue
			const candidate = value as Record<string, unknown>
			if (typeof candidate.title === 'string' && typeof candidate.named === 'boolean') {
				titles[id] = { title: candidate.title, named: candidate.named }
			}
		}
		return titles
	} catch {
		// Absent, unreadable, or not JSON. A conversation with no chosen name
		// still has a derived one, so the honest fallback is "nobody named
		// anything" rather than a failure the operator cannot act on.
		return {}
	}
}

function writeTitles(root: string, titles: Readonly<Record<string, StoredTitle>>): void {
	mkdirSync(root, { recursive: true })
	writeFileSync(titlesPath(root), `${JSON.stringify(titles, null, 2)}\n`, 'utf-8')
}

/** The name a person gave this conversation, or `undefined`. */
export function titleOf(s: CliSessions, sessionId: SessionId): string | undefined {
	const stored = readTitles(s.root)[sessionId as string]
	return stored?.named ? stored.title : undefined
}

/**
 * Name a conversation, or with an empty name, take the name away.
 *
 * Removing rather than storing `''` is what keeps "named" a real distinction:
 * an empty string is not a name, and leaving one behind would make `/resume`
 * show a blank row that reads as a conversation with nothing in it.
 */
export function setTitle(s: CliSessions, sessionId: SessionId, title: string): void {
	const titles = readTitles(s.root)
	const trimmed = title.trim()
	if (trimmed === '') delete titles[sessionId as string]
	else titles[sessionId as string] = { title: trimmed, named: true }
	writeTitles(s.root, titles)
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
 * title — and `/resume` would show two rows a person cannot tell apart, which
 * is a worse outcome than not being able to fork at all. The name is taken
 * from the source's own, so a fork of a fork stays readable, and it is
 * numbered against the names already in use so a second fork does not collide
 * with the first.
 */
export async function forkConversation(
	s: CliSessions,
	sourceId: SessionId,
): Promise<{ id: SessionId; title: string; copied: number }> {
	const messages = await loadConversation(s, sourceId)
	if (messages.length === 0) {
		// Refused rather than served. A fork of nothing is an empty session
		// that shows up in `/resume` forever and answers no question.
		throw new Error('There is nothing to fork yet — this conversation has no messages.')
	}

	const { id, title } = await writeFork(s, sourceId, messages, messages, { kind: 'all' })
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
 * and restores that prompt to the composer; refusing it would make the most
 * common first-turn correction the one prompt this feature cannot edit.
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
	const { id, title } = await writeFork(s, sourceId, messages, prefix, {
		kind: 'before-user',
		userOrdinal,
	})
	return { id, title, messages: prefix, selected }
}

/** Create and name one fork after every boundary decision has been validated. */
async function writeFork(
	s: CliSessions,
	sourceId: SessionId,
	sourceMessages: readonly Message[],
	copiedMessages: readonly Message[],
	boundary:
		| { readonly kind: 'all' }
		| { readonly kind: 'before-user'; readonly userOrdinal: number },
): Promise<{ id: SessionId; title: string }> {
	const source = readTitles(s.root)[sourceId as string]?.title ?? conversationTitle(sourceMessages)
	const origin = await forkOrigin(s, sourceId, sourceMessages, copiedMessages.length, boundary)
	const id = await createConversation(s)
	// The copied model context is published as one replacement record and read
	// back before lineage is committed. If the process dies before origin, export
	// refuses; once origin exists, a restart cannot observe a half-copied prefix.
	await s.store.replaceMessages(id, copiedMessages, s.tenantId)
	const copiedBack = await loadConversation(s, id)
	if (!isDeepStrictEqual(copiedBack, copiedMessages)) {
		throw new Error(
			`The forked conversation did not preserve its exact copied history. No lineage record was published for ${id}.`,
		)
	}
	await s.turnEvidence?.recordOrigin(id, origin)
	const title = nextForkName(
		Object.fromEntries(
			Object.entries(readTitles(s.root)).map(([key, value]) => [key, value.title]),
		),
		source,
	)
	setTitle(s, id, title)
	return { id, title }
}

async function forkOrigin(
	s: CliSessions,
	sourceId: SessionId,
	sourceMessages: readonly Message[],
	copiedMessages: number,
	boundary:
		| { readonly kind: 'all' }
		| { readonly kind: 'before-user'; readonly userOrdinal: number },
): Promise<ConversationOrigin> {
	const unresolved: ConversationOrigin = {
		kind: 'fork-unresolved',
		sourceSessionId: sourceId,
		copiedMessages,
	}
	if (!s.turnEvidence) return unresolved

	try {
		const lineage = await s.turnEvidence.resolveLineage(sourceId)
		if (lineage.kind !== 'available') return unresolved
		const durableTurns = durableTurnProjections(sourceMessages)
		if (!durableTurns || durableTurns.length === 0) return unresolved
		const selected =
			boundary.kind === 'all'
				? uniqueLineageIndex(durableTurns, lineage.turns, durableTurns.length - 1)
				: uniqueLineageIndex(durableTurns, lineage.turns, boundary.userOrdinal)
		if (selected === undefined) return unresolved
		const copiedTurnCount = boundary.kind === 'all' ? selected + 1 : selected

		return {
			kind: 'fork',
			sourceSessionId: sourceId,
			copiedMessages,
			turns: lineage.turns
				.slice(0, copiedTurnCount)
				.map((turn) => ({ ...turn.reference }) satisfies ConversationTurnReference),
		}
	} catch {
		// Forking model history remains useful when old/foreign evidence cannot
		// prove lineage. The origin says so explicitly, and complete export refuses.
		return unresolved
	}
}

interface DurableTurnProjection {
	readonly user: UserMessage
	readonly assistantText?: string
}

function durableTurnProjections(messages: readonly Message[]): DurableTurnProjection[] | undefined {
	const turns: Array<{ user: UserMessage; assistantText?: string }> = []
	for (const message of messages) {
		if (message.role === 'user') {
			turns.push({ user: message })
			continue
		}
		if (message.role !== 'assistant') continue
		const turn = turns.at(-1)
		if (!turn || turn.assistantText !== undefined || typeof message.content !== 'string') {
			return undefined
		}
		turn.assistantText = message.content
	}
	return turns
}

/** Unique source-turn boundary for one user selected from a possibly compacted suffix. */
function uniqueLineageIndex(
	durable: readonly DurableTurnProjection[],
	lineage: readonly ConversationLineageTurn[],
	selectedUser: number,
): number | undefined {
	if (selectedUser < 0 || selectedUser >= durable.length) return undefined
	const prefix = alignmentTable(durable, lineage)
	const reversedDurable = [...durable].reverse()
	const reversedLineage = [...lineage].reverse()
	const suffix = alignmentTable(reversedDurable, reversedLineage)
	const candidates: number[] = []
	for (let index = 0; index < lineage.length; index += 1) {
		if (!projectionMatches(durable[selectedUser], lineage[index])) continue
		const beforeFits = prefix[selectedUser]?.[index] === true
		const durableAfter = durable.length - selectedUser - 1
		const lineageAfter = lineage.length - index - 1
		const afterFits = suffix[durableAfter]?.[lineageAfter] === true
		if (beforeFits && afterFits) candidates.push(index)
	}
	return candidates.length === 1 ? candidates[0] : undefined
}

/** DP table: whether the first i needles embed, in order, within the first j haystack values. */
function alignmentTable(
	needles: readonly DurableTurnProjection[],
	haystack: readonly ConversationLineageTurn[],
): boolean[][] {
	const table = Array.from({ length: needles.length + 1 }, () =>
		Array.from({ length: haystack.length + 1 }, () => false),
	)
	for (let column = 0; column <= haystack.length; column += 1) table[0][column] = true
	for (let row = 1; row <= needles.length; row += 1) {
		for (let column = 1; column <= haystack.length; column += 1) {
			table[row][column] =
				table[row]?.[column - 1] === true ||
				(table[row - 1]?.[column - 1] === true &&
					projectionMatches(needles[row - 1], haystack[column - 1]))
		}
	}
	return table
}

function projectionMatches(
	durable: DurableTurnProjection | undefined,
	lineage: ConversationLineageTurn | undefined,
): boolean {
	if (!durable || !lineage || !isDeepStrictEqual(durable.user, lineage.evidence.started.user)) {
		return false
	}
	const settled = lineage.evidence.settled
	if (!settled) return false
	return durable.assistantText === undefined
		? settled.assistantText.trim().length === 0
		: settled.assistantText === durable.assistantText
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

function conversationTitle(messages: readonly Message[]): string {
	const firstUser = messages.find((m) => m.role === 'user')
	const raw = typeof firstUser?.content === 'string' ? firstUser.content : 'Conversation'
	const text = raw.replace(/\s+/g, ' ').trim()
	return text.length > 60 ? `${text.slice(0, 59)}…` : text || 'Conversation'
}

function toIso(value: unknown): string {
	if (value instanceof Date) return value.toISOString()
	return typeof value === 'string' ? value : new Date(0).toISOString()
}

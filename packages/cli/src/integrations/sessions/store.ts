/**
 * Conversation persistence for the TUI, built on the SDK's session
 * hierarchy (`DiskSessionStore`) — no parallel store. Each canonical cwd is
 * one Project (an immutable root binding keeps its id stable across launches),
 * every conversation is a Session under a fixed CLI Topic, and the
 * conversation's messages are appended to the Session as turns complete.
 *
 * This is what powers `/resume`: list recent sessions, load a chosen
 * session's messages, and keep chatting in it. New workspaces bind their
 * canonical working directory to one Project below the application home;
 * existing project-local stores remain readable through the legacy route.
 */

import { randomBytes } from 'node:crypto'
import {
	chmodSync,
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
	DefaultPathBuilder,
	DiskSessionGoalStore,
	DiskSessionStore,
	type Message,
	type ProjectId,
	type Session,
	type SessionGoalStore,
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
import { restrictToOwner } from '../providers/credential-store.js'
import { resolveNamzuHome } from '../state/home.js'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'
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
	/** Durable completion goal owned by each conversation Session. */
	readonly goals: SessionGoalStore
	readonly projectId: ProjectId
	readonly topicId: TopicId
	readonly tenantId: TenantId
	/** Absolute hierarchy root used by the SDK path builder. */
	readonly root: string
	/** Generated state owned by this Project inside {@link root}. */
	readonly projectStateRoot: string
	/** CLI-only sidecars for this Project. Legacy stores use their old root. */
	readonly controlRoot: string
	/** Which durable backend was selected by the state-routing decision. */
	readonly backend: 'central' | 'legacy'
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
export interface OpenSessionsOptions {
	/** Exact central hierarchy root; test/embedding seam. */
	readonly stateRoot?: string
	/** OS-home and environment seams used by the application-home resolver. */
	readonly home?: string
	readonly env?: NodeJS.ProcessEnv
}

type LegacyRoute =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'valid'
			readonly root: string
			readonly projectId: ProjectId
	  }
	| { readonly kind: 'refuse'; readonly detail: string }

const AUTHORED_LOCAL_ENTRIES = new Set(['commands', 'config.yaml', 'plugins', 'skills'])

async function inspectLegacyRoute(
	localRoot: string,
	options: { readonly allowApplicationHomeEntries?: boolean } = {},
): Promise<LegacyRoute> {
	try {
		const rootEntry = lstatSync(localRoot)
		if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
			return {
				kind: 'refuse',
				detail: `${localRoot} is not a real directory.`,
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' }
		return {
			kind: 'refuse',
			detail: `${localRoot} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
		}
	}

	const pointerPath = join(localRoot, 'cli.json')
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(pointerPath, 'utf8'))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			// When the working directory is the OS home, the project-local path
			// and the application home are the same directory. Its ordinary config
			// and generated partitions are not evidence of an unbound legacy
			// project. A present cli.json is still inspected below; only the
			// no-pointer classification is relaxed for this natural overlap.
			if (options.allowApplicationHomeEntries) return { kind: 'none' }
			const unclassified = readdirSync(localRoot).filter(
				(name) => !AUTHORED_LOCAL_ENTRIES.has(name),
			)
			return unclassified.length === 0
				? { kind: 'none' }
				: {
						kind: 'refuse',
						detail: `${localRoot} contains legacy or unknown generated entries (${unclassified.join(', ')}) but no cli.json binding.`,
					}
		}
		return {
			kind: 'refuse',
			detail: `${pointerPath} is not valid JSON; refusing to hide recoverable local history behind a new central Project.`,
		}
	}

	const projectIdValue =
		typeof raw === 'object' && raw !== null && 'projectId' in raw
			? (raw as { projectId?: unknown }).projectId
			: undefined
	if (typeof projectIdValue !== 'string' || !projectIdValue.startsWith('prj_')) {
		return {
			kind: 'refuse',
			detail: `${pointerPath} does not contain a valid Project id.`,
		}
	}
	const projectId = asProjectId(projectIdValue)
	try {
		const legacyStore = new DiskSessionStore({ rootDir: localRoot })
		const project = await legacyStore.getProject(projectId, TENANT)
		if (!project) {
			return {
				kind: 'refuse',
				detail: `${pointerPath} points to ${projectId}, but that local Project record is missing.`,
			}
		}
		const workingDirectory = resolve(localRoot, '..')
		if (project.rootPath !== undefined && project.rootPath !== workingDirectory) {
			return {
				kind: 'refuse',
				detail: `${pointerPath} points to ${projectId}, but that Project is bound to ${project.rootPath} instead of ${workingDirectory}.`,
			}
		}
		return { kind: 'valid', root: localRoot, projectId }
	} catch (error) {
		return {
			kind: 'refuse',
			detail: `The legacy Project selected by ${pointerPath} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}

/**
 * Select one durable backend for the canonical working directory.
 *
 * A valid legacy store remains authoritative until a separately leased data
 * migration exists. A split or corrupt estate refuses; it never turns missing
 * metadata into an apparently empty new history.
 */
export async function openSessions(
	cwd: string,
	options: OpenSessionsOptions = {},
): Promise<CliSessions> {
	const workingDirectory = await realpath(resolve(cwd))
	const centralRoot = resolve(
		options.stateRoot ??
			resolveNamzuHome({
				...(options.home !== undefined ? { home: options.home } : {}),
				...(options.env !== undefined ? { env: options.env } : {}),
			}),
	)
	const localRoot = join(workingDirectory, '.namzu')
	const overlaps = centralRoot === localRoot
	const legacy = await inspectLegacyRoute(localRoot, {
		allowApplicationHomeEntries: overlaps,
	})
	if (legacy.kind === 'refuse') {
		throw new Error(`${legacy.detail} Run \`namzu state\` for a read-only inventory.`)
	}

	const centralStore = new DiskSessionStore({ rootDir: centralRoot })
	const centralProject = await centralStore.findProjectByRootPath(workingDirectory, TENANT)
	if (
		legacy.kind === 'valid' &&
		centralProject &&
		(!overlaps || centralProject.id !== legacy.projectId)
	) {
		throw new Error(
			`Both legacy state at ${localRoot} and central state at ${centralRoot} are bound to this workspace. Refusing to choose between split histories; run \`namzu state\` for the two inventories.`,
		)
	}

	let root: string
	let store: DiskSessionStore
	let projectId: ProjectId
	let backend: CliSessions['backend']
	if (legacy.kind === 'valid') {
		root = legacy.root
		store = new DiskSessionStore({ rootDir: root })
		projectId = legacy.projectId
		backend = 'legacy'
		ensurePrivateStateDirectory(root, 'projects')
		ensurePrivateStateDirectory(root, 'goals')
	} else {
		root = centralRoot
		ensurePrivateStateDirectory(root, 'projects')
		ensurePrivateStateDirectory(root, 'goals')
		store = centralStore
		let project = centralProject
		if (!project) {
			try {
				project = await store.createProject(
					{ tenantId: TENANT, name: 'namzu CLI', rootPath: workingDirectory },
					TENANT,
				)
			} catch (error) {
				// Another process may have won the immutable root binding between our
				// lookup and publication. Re-read; every other failure stays a failure.
				project = await store.findProjectByRootPath(workingDirectory, TENANT)
				if (!project) throw error
			}
		}
		projectId = project.id
		backend = 'central'
	}

	const projectStateRoot = new DefaultPathBuilder(root).projectDir(projectId)
	const controlRoot = backend === 'central' ? join(projectStateRoot, 'cli') : root
	if (backend === 'central') ensurePrivateStateDirectory(projectStateRoot, 'cli')
	// The root also holds authored project commands/plugins and may legitimately
	// be shareable. Generated conversation and goal state is not: make those
	// partitions the owner-only privacy boundary before any store writes.
	return {
		store,
		goals: new DiskSessionGoalStore({ rootDir: root, sessions: store }),
		projectId,
		topicId: THREAD,
		tenantId: TENANT,
		root,
		projectStateRoot,
		controlRoot,
		backend,
		turnEvidence: new DiskConversationEvidence({ root, projectId }),
	}
}

// Maps an embedder's own session key (e.g. a desktop host's uuid) to a
// namzu conversation id, so reopening that session resumes the same
// transcript. Kept as a small JSON pointer beside cli.json.
const DESKTOP_MAP = 'desktop-sessions.json'
const DESKTOP_MAP_LOCK = `${DESKTOP_MAP}.lock`
const DESKTOP_MAP_LOCK_TIMEOUT_MS = 5_000
const DESKTOP_MAP_LOCK_POLL_MS = 10

function readDesktopMap(root: string): Record<string, string> {
	const path = join(root, DESKTOP_MAP)
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
		throw new Error(
			`Cannot read ${path}; refusing to replace an existing desktop-session map: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error(
			`Cannot read ${path}; its top level must be an object. Refusing to replace the existing desktop-session map.`,
		)
	}
	const map: Record<string, string> = {}
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== 'string' || !value.startsWith('ses_')) {
			throw new Error(
				`Cannot read ${path}; desktop session ${JSON.stringify(key)} does not name a Session id. Refusing to replace the existing map.`,
			)
		}
		// Validate the full branded-id grammar instead of accepting only a
		// prefix that happens to look right.
		asSessionId(value)
		map[key] = value
	}
	return map
}

function wait(ms: number): Promise<void> {
	return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

/**
 * Hold one process-wide lease while mutating the shared desktop map.
 *
 * `open(..., "wx")` is the filesystem's exclusive-create primitive, so two
 * Namzu processes cannot both perform a stale read-modify-write. A crashed
 * owner deliberately leaves a lock behind: guessing that it is stale and
 * deleting it automatically would reintroduce the race this lease prevents.
 */
async function acquireDesktopMapLock(root: string): Promise<() => void> {
	mkdirSync(root, { recursive: true })
	const path = join(root, DESKTOP_MAP_LOCK)
	const token = `${process.pid}:${randomBytes(12).toString('hex')}`
	const deadline = Date.now() + DESKTOP_MAP_LOCK_TIMEOUT_MS
	for (;;) {
		let descriptor: number | undefined
		try {
			descriptor = openSync(path, 'wx', 0o600)
			writeFileSync(descriptor, `${token}\n`, 'utf8')
			fsyncSync(descriptor)
			closeSync(descriptor)
			descriptor = undefined
			if (process.platform !== 'win32') chmodSync(path, 0o600)
			restrictToOwner(path)
			return () => {
				try {
					if (readFileSync(path, 'utf8').trim() === token) rmSync(path, { force: true })
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
				}
			}
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor)
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				// We may have created the path and then failed to initialize it. It
				// cannot be mistaken for somebody else's lock because exclusive
				// create succeeded in this branch.
				try {
					if (readFileSync(path, 'utf8').trim() === token) rmSync(path, { force: true })
				} catch {
					// Preserve the original acquisition error.
				}
				throw error
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`Timed out waiting for ${path}. Another Namzu process may be updating desktop session bindings. If no Namzu process is running, inspect and remove this stale lock manually.`,
				)
			}
			await wait(DESKTOP_MAP_LOCK_POLL_MS)
		}
	}
}

/**
 * Resolve (creating if needed) the namzu conversation bound to an embedder's
 * session key. The mapping persists so a later turn / a history load with the
 * same key reuses the same conversation. Falls back to a fresh conversation if
 * the mapped id was wiped.
 */
export async function resolveConversation(s: CliSessions, key: string): Promise<SessionId> {
	const existing = await resolveExistingConversation(s, key, readDesktopMap(s.controlRoot))
	if (existing) {
		await requireWritableConversation(s, existing, 'continue keyed conversation')
		return existing
	}

	const release = await acquireDesktopMapLock(s.controlRoot)
	try {
		// A different process may have published this key while we waited.
		const map = readDesktopMap(s.controlRoot)
		const winner = await resolveExistingConversation(s, key, map)
		if (winner) {
			await requireWritableConversation(s, winner, 'continue keyed conversation')
			return winner
		}
		const id = await startConversation(s)
		map[key] = id
		writePrivateJson(s.controlRoot, DESKTOP_MAP, map)
		return id
	} finally {
		release()
	}
}

/** Read an external-session binding without creating or widening its scope. */
export async function findMappedConversation(
	s: CliSessions,
	key: string,
): Promise<SessionId | null> {
	return await resolveExistingConversation(s, key, readDesktopMap(s.controlRoot))
}

async function resolveExistingConversation(
	s: CliSessions,
	key: string,
	map: Readonly<Record<string, string>>,
): Promise<SessionId | null> {
	const existing = map[key]
	// Same treatment as the project pointer above: a mapped id that is not an
	// id is indistinguishable from one whose session was wiped. The read-only
	// caller reports no binding; the writable caller may then mint a fresh one.
	if (existing?.startsWith('ses_')) {
		const mapped = asSessionId(existing)
		const session = await s.store.getSession(mapped, s.tenantId)
		if (session?.projectId === s.projectId && session.topicId === s.topicId) return mapped
	}
	return null
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

/**
 * Resolve a conversation through the cwd-owned Project and CLI Topic.
 *
 * `SessionId` is globally locatable inside a store root, so successfully
 * loading one proves existence and tenant ownership, not that it belongs to
 * this `CliSessions` handle. The fixed CLI topic id makes the Project check
 * load-bearing: two Projects in one root can legitimately carry the same
 * topic id.
 */
async function requireConversationInScope(
	s: CliSessions,
	sessionId: SessionId,
	op: string,
): Promise<Session> {
	const session = await s.store.getSession(sessionId, s.tenantId)
	if (!session) {
		throw new Error(`Conversation ${sessionId} was not found — ${op} rejected`)
	}
	if (session.projectId !== s.projectId || session.topicId !== s.topicId) {
		throw new Error(`Conversation ${sessionId} does not belong to this workspace — ${op} rejected`)
	}
	return session
}

/**
 * Sequential admission gate for a turn or conversation mutation.
 *
 * This establishes the state observed immediately before the operation. It is
 * deliberately not described as a cross-process transaction: Project archive
 * and Session mutation live in separate store records, so serializing an
 * archive racing a live turn requires a durable lease shared by both paths.
 * What this gate does guarantee is that a target already closed, archived or
 * outside the current Project never silently reaches the requested operation.
 */
export async function requireWritableConversation(
	s: CliSessions,
	sessionId: SessionId,
	op = 'continue conversation',
): Promise<void> {
	const session = await requireConversationInScope(s, sessionId, op)
	await requireOpenProject(s.store, s.projectId, s.tenantId, op)
	if (session.status === 'archived') {
		throw new Error(
			`Conversation ${sessionId} is archived and read-only — ${op} rejected. Its history remains available for inspection.`,
		)
	}
}

/**
 * Turn the active conversation into a read-only tombstone.
 *
 * The caller owns the live-turn barrier; this function owns store scope and a
 * versioned publication. History remains readable, while `/resume`, later
 * appends and forks reject through {@link requireWritableConversation}.
 */
export async function archiveConversation(s: CliSessions, sessionId: SessionId): Promise<void> {
	const session = await requireConversationInScope(s, sessionId, 'archive conversation')
	await requireOpenProject(s.store, s.projectId, s.tenantId, 'archive conversation')
	if (session.status === 'archived') {
		throw new Error(`Conversation ${sessionId} is already archived.`)
	}
	await s.store.updateSession(
		{ ...session, status: 'archived', ownerVersion: session.ownerVersion + 1 },
		s.tenantId,
		session.ownerVersion,
	)
}

/** Append messages (in order) to a conversation. */
export async function appendMessages(
	s: CliSessions,
	sessionId: SessionId,
	messages: readonly Message[],
): Promise<void> {
	await requireWritableConversation(s, sessionId, 'append conversation messages')
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
	await requireWritableConversation(s, sessionId, 'replace conversation history')
	const existing = await loadConversation(s, sessionId)
	const titles = readTitles(s.controlRoot)
	if (titles[sessionId as string] === undefined) {
		titles[sessionId as string] = {
			title: conversationTitle(existing),
			named: false,
		}
		writeTitles(s.controlRoot, titles)
	}
	await s.store.replaceMessages(sessionId, messages, s.tenantId)
}

/** Load a conversation's full message history. */
export async function loadConversation(s: CliSessions, sessionId: SessionId): Promise<Message[]> {
	await requireConversationInScope(s, sessionId, 'load conversation history')
	return [...(await s.store.loadMessages(sessionId, s.tenantId))]
}

/**
 * Load one conversation for a new model turn.
 *
 * Reading an archived conversation remains legitimate — `history` and export
 * are inspection surfaces — but resuming it would turn a tombstone back into a
 * live writer without a restore operation. The Project gate is separate for
 * the same reason: closing a workspace must not make its history disappear,
 * while it must stop a later turn from starting there.
 */
export async function loadResumableConversation(
	s: CliSessions,
	sessionId: string,
): Promise<Message[]> {
	const checked = asSessionId(sessionId)
	await requireWritableConversation(s, checked, 'resume conversation')
	return [...(await s.store.loadMessages(checked, s.tenantId))]
}

/** Recent non-empty conversations, newest first — for the `/resume` list. */
export async function listRecent(s: CliSessions, limit = 20): Promise<RecentConversation[]> {
	await requireOpenProject(s.store, s.projectId, s.tenantId, 'list resumable conversations')
	const sessions = await s.store.listSessionsByTopic(s.topicId, s.tenantId)
	const titles = readTitles(s.controlRoot)
	const out: RecentConversation[] = []
	for (const sess of sessions) {
		// The CLI Topic id is intentionally stable, so a store root that contains
		// an older Project can contain the same topic id more than once. The cwd's
		// selected Project — `s.projectId` — is the authority; Topic membership
		// alone is not. Archived Session records are tombstones, not resume rows.
		if (sess.projectId !== s.projectId || sess.status === 'archived') continue
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
	writePrivateJson(root, TITLES_FILE, titles)
}

/** Crash-safe publication for the small CLI sidecars scoped to one Project. */
function writePrivateJson(root: string, filename: string, value: unknown): void {
	mkdirSync(root, { recursive: true })
	const path = join(root, filename)
	const temporary = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: 'utf-8',
			flag: 'wx',
			mode: 0o600,
		})
		if (process.platform !== 'win32') chmodSync(temporary, 0o600)
		restrictToOwner(temporary)
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
}

/** The name a person gave this conversation, or `undefined`. */
export function titleOf(s: CliSessions, sessionId: SessionId): string | undefined {
	const stored = readTitles(s.controlRoot)[sessionId as string]
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
	const titles = readTitles(s.controlRoot)
	const trimmed = title.trim()
	if (trimmed === '') delete titles[sessionId as string]
	else titles[sessionId as string] = { title: trimmed, named: true }
	writeTitles(s.controlRoot, titles)
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
	await requireWritableConversation(s, sourceId, 'fork conversation')
	const messages = await loadConversation(s, sourceId)
	if (messages.length === 0) {
		// Refused rather than served. A fork of nothing is an empty session
		// that shows up in `/resume` forever and answers no question.
		throw new Error('There is nothing to fork yet — this conversation has no messages.')
	}

	const { id, title } = await writeFork(s, sourceId, messages, messages, {
		kind: 'all',
	})
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
	const source =
		readTitles(s.controlRoot)[sourceId as string]?.title ?? conversationTitle(sourceMessages)
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
			Object.entries(readTitles(s.controlRoot)).map(([key, value]) => [key, value.title]),
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

function toIso(value: unknown): string {
	if (value instanceof Date) return value.toISOString()
	return typeof value === 'string' ? value : new Date(0).toISOString()
}

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveNamzuHome } from '../../session/home.js'
import { type SessionLocator, SessionPaths, ensureProject } from '../../session/paths.js'
import {
	DiskSessionTokenBudgetStore,
	InMemorySessionTokenBudgetStore,
	type SessionTokenBudgetStore,
} from '../../store/budget/index.js'
import {
	type CheckpointLogView,
	type CheckpointScope,
	DiskSessionCheckpointStore,
	InMemorySessionCheckpointStore,
	type SessionCheckpointStore,
} from '../../store/checkpoint/index.js'
import {
	DiskSessionLog,
	type InMemoryLogMedium,
	InMemorySessionLog,
	type SessionLog,
} from '../../store/session-log/index.js'
import type { ChildSessionStorage } from '../../types/agent/task.js'
import type { CheckpointId, SessionId } from '../../types/ids/index.js'
import { asSessionId, isEntityId } from '../../utils/id.js'

/** What an in-memory session keeps beside its log. */
interface HeldState {
	readonly checkpoints: InMemorySessionCheckpointStore
	readonly tokenBudgets: InMemorySessionTokenBudgetStore
}

/** Keyed by the log's bytes, so a reopened instance of one log finds the same stores. */
const held = new WeakMap<InMemoryLogMedium, HeldState>()

/** Where one session's log, checkpoints, ledger and child sessions go. */
export interface SessionStorage {
	readonly log: SessionLog
	/** The project layout, when the session is on disk. */
	readonly paths: SessionPaths | undefined
	/** `<session-id>/`, beside the log, when the log is on disk. */
	readonly sessionDir: string | undefined
	readonly checkpoints: SessionCheckpointStore
	/** Ledgers of root turns, keyed by (rootSessionId, rootTurnId). */
	readonly tokenBudget: SessionTokenBudgetStore
	/** What a delegated child session is told; `undefined` leaves it alone. */
	readonly children: ChildSessionStorage | undefined
}

export interface SessionStorageInput {
	readonly sessionId: SessionId
	/** The delegating session, for a child session's default log location. */
	readonly parentSessionId?: SessionId
	readonly sessionLog?: SessionLog
	readonly paths?: SessionPaths
	readonly checkpointStore?: SessionCheckpointStore
	readonly tokenBudgetStore?: SessionTokenBudgetStore
	/** The directory the project slug is derived from when no `paths` is given. */
	readonly workingDirectory?: string
}

/**
 * The one answer to "where does this session's state live", read by every
 * place that opens a session log, a checkpoint store or a token ledger.
 *
 * - **Log.** An explicit `sessionLog` wins. Otherwise the log at `paths`
 *   (default: `SessionPaths` under `resolveNamzuHome()` for the working
 *   directory's project).
 * - **Checkpoints and ledger.** An explicit store wins. Otherwise a session
 *   whose log is an {@link InMemorySessionLog} and which names no `paths`
 *   keeps both in memory, beside its log; every other session keeps them on
 *   disk under `<session-id>/checkpoints/` and `<root-session-id>/budgets/`.
 * - **Children.** An in-memory session hands that choice to its delegated
 *   children, so a child does not fall back to a disk tree its parent never
 *   asked for; a session on disk hands down its layout, so its children's
 *   logs nest under its session directory.
 */
export async function resolveSessionStorage(input: SessionStorageInput): Promise<SessionStorage> {
	const inMemory = input.sessionLog instanceof InMemorySessionLog && input.paths === undefined
	const paths =
		input.paths ?? (inMemory ? undefined : await defaultSessionPaths(input.workingDirectory))
	const locator = input.sessionLog
		? input.sessionLog instanceof DiskSessionLog
			? input.sessionLog.locator
			: undefined
		: await locateSession(paths as SessionPaths, input.sessionId, input.parentSessionId)
	const log =
		input.sessionLog ?? DiskSessionLog.at(paths as SessionPaths, locator as SessionLocator)
	const state = inMemory ? heldState(log as InMemorySessionLog) : undefined
	const checkpoints =
		input.checkpointStore ??
		state?.checkpoints ??
		new DiskSessionCheckpointStore({
			paths: paths as SessionPaths,
			log: checkpointLogView(log),
			...(locator ? { session: locator } : {}),
		})
	const tokenBudget =
		input.tokenBudgetStore ??
		state?.tokenBudgets ??
		new DiskSessionTokenBudgetStore({ paths: paths as SessionPaths })
	const children: ChildSessionStorage | undefined = inMemory
		? {
				kind: 'memory',
				...(input.checkpointStore ? { checkpointStore: input.checkpointStore } : {}),
			}
		: paths
			? { kind: 'disk', paths }
			: undefined
	const sessionDir = log instanceof DiskSessionLog ? log.sessionDir : undefined
	return { log, paths, sessionDir, checkpoints, tokenBudget, children }
}

/**
 * The locator of a session named without its log: a root session sits at the
 * top of the project; a child session sits under its parent, wherever the
 * parent is. The parent's own place is found on disk, so a grandchild nests
 * under every ancestor and not beside its parent at the top level. A parent
 * with no log in the layout yet is taken to be a root session.
 */
export async function locateSession(
	paths: SessionPaths,
	sessionId: SessionId,
	parentSessionId?: SessionId,
): Promise<SessionLocator> {
	if (!parentSessionId) return { sessionId }
	const parent = (await findSessionLocator(paths, parentSessionId)) ?? {
		sessionId: parentSessionId,
	}
	return { sessionId, ancestors: [...(parent.ancestors ?? []), parent.sessionId] }
}

/** Deeper than any delegation tree a project allows; a guard against a cyclic tree on disk. */
const MAX_SEARCH_DEPTH = 64

/**
 * Where `sessionId`'s log is in the project's layout: at the top level, or in
 * some session's `subagents/`, searched breadth first. `undefined` when no log
 * of that session exists.
 */
async function findSessionLocator(
	paths: SessionPaths,
	sessionId: SessionId,
): Promise<SessionLocator | undefined> {
	const target = `${sessionId}.jsonl`
	let frontier: SessionLocator[] = []
	const top = await listDirectory(paths.projectDir())
	if (top.files.has(target)) return { sessionId }
	for (const name of top.directories) {
		if (isEntityId(name, 'session')) frontier.push({ sessionId: asSessionId(name) })
	}
	for (let depth = 0; depth < MAX_SEARCH_DEPTH && frontier.length > 0; depth++) {
		const next: SessionLocator[] = []
		for (const parent of frontier) {
			const children = await listDirectory(join(paths.sessionDir(parent), 'subagents'))
			const ancestors = [...(parent.ancestors ?? []), parent.sessionId]
			if (children.files.has(target)) return { sessionId, ancestors }
			for (const name of children.directories) {
				if (isEntityId(name, 'session')) next.push({ sessionId: asSessionId(name), ancestors })
			}
		}
		frontier = next
	}
	return undefined
}

async function listDirectory(
	directory: string,
): Promise<{ files: Set<string>; directories: string[] }> {
	try {
		const entries = await readdir(directory, { withFileTypes: true })
		return {
			files: new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name)),
			directories: entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort(),
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ENOENT' || code === 'ENOTDIR') return { files: new Set(), directories: [] }
		throw error
	}
}

/** `SessionPaths` for the working directory's project under `resolveNamzuHome()`. */
export async function defaultSessionPaths(workingDirectory?: string): Promise<SessionPaths> {
	const home = resolveNamzuHome()
	const project = await ensureProject({ home, cwd: workingDirectory ?? process.cwd() })
	return new SessionPaths({ home, slug: project.slug })
}

function heldState(log: InMemorySessionLog): HeldState {
	const current = held.get(log.medium)
	if (current) return current
	const next: HeldState = {
		checkpoints: new InMemorySessionCheckpointStore({ log: checkpointLogView(log) }),
		tokenBudgets: new InMemorySessionTokenBudgetStore(),
	}
	held.set(log.medium, next)
	return next
}

/**
 * @internal What an in-memory session holds beside its log right now, for
 * tests that assert where its state went.
 */
export function heldSessionState(log: InMemorySessionLog): HeldState | undefined {
	return held.get(log.medium)
}

/**
 * The checkpoint store's view of one session log: whether a checkpoint was
 * committed, whether the prefix it covers is intact, and which checkpoints
 * an open decision still references.
 */
export function checkpointLogView(log: SessionLog): CheckpointLogView {
	const own = (scope: CheckpointScope): void => {
		if (scope.sessionId !== log.sessionId) {
			throw new Error(
				`This checkpoint store answers for session ${log.sessionId}, not ${scope.sessionId}.`,
			)
		}
	}
	return {
		async verifyThrough(scope, throughSeq, throughSha256) {
			own(scope)
			const read = await log.readAll({ mode: 'tolerant', throughSeq })
			const entry = read.entries.at(-1)
			return entry?.pointer.seq === throughSeq && entry.pointer.sha256 === throughSha256
		},
		async writtenDocSha256(scope, checkpointId) {
			own(scope)
			let found: string | null = null
			for await (const { record } of log.read({ mode: 'tolerant' })) {
				if (record.type === 'checkpoint_written' && record.checkpointId === checkpointId) {
					found = record.docSha256
				}
			}
			return found
		},
		async openDecisionCheckpoints(scope) {
			own(scope)
			const open = new Map<string, CheckpointId>()
			for await (const { record } of log.read({ mode: 'tolerant' })) {
				if (record.type === 'decision_requested') open.set(record.decisionId, record.checkpointId)
				if (record.type === 'decision_resolved' || record.type === 'decision_expired') {
					open.delete(record.decisionId)
				}
			}
			return open.values()
		},
	}
}

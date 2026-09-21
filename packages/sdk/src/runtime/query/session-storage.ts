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
	const log =
		input.sessionLog ??
		DiskSessionLog.at(paths as SessionPaths, sessionLocator(input.sessionId, input.parentSessionId))
	const state = inMemory ? heldState(log as InMemorySessionLog) : undefined
	const checkpoints =
		input.checkpointStore ??
		state?.checkpoints ??
		new DiskSessionCheckpointStore({ paths: paths as SessionPaths, log: checkpointLogView(log) })
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

/** The locator of a session: a child names its parent, whose directory holds its log. */
export function sessionLocator(sessionId: SessionId, parentSessionId?: SessionId): SessionLocator {
	return parentSessionId ? { sessionId, ancestors: [parentSessionId] } : { sessionId }
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

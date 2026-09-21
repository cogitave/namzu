import {
	type ChildSessionSummary,
	type Logger,
	SESSION_EVENT_TYPES,
	type SessionEvent,
	type SessionIndex,
	type SessionLocator,
	type SessionLogEntry,
	type SessionPaths,
	type SessionRecord,
	type TurnExecutionStatus,
	asSessionId,
	readSessionLog,
} from '@namzu/sdk'

import {
	type SubagentActivity,
	SubagentActivityMonitor,
	type SubagentActivityStatus,
} from './activity.js'

/**
 * Child summaries one listing considers.
 *
 * The index answers `listChildren` from one query, so this no longer bounds a
 * directory scan. It bounds what one listing does with the answer: a
 * conversation that delegated tens of thousands of times is still summarised
 * from its most recent work rather than from its whole history. Children are
 * taken newest first, so past this many it is the OLDEST that stop being
 * counted.
 */
export const MAX_CONSIDERED_CHILDREN = 2_000

/**
 * Children replayed into one monitor, matching the live monitor's own
 * retention. Replay walks the newest first and stops at this many, so a
 * conversation that delegated thousands of times opens its most recent work
 * instead of its whole history.
 */
export const MAX_REPLAYED_CHILDREN = 80

/** The parts of the session index a saved-children reader asks. */
export type SavedChildIndex = Pick<SessionIndex, 'refresh' | 'listChildren'>

/** Where a conversation's delegated children are recorded. */
export interface SavedChildScope {
	/**
	 * The index over the project's logs. The conversation's own log is
	 * refreshed before it is asked, so a child spawned a moment ago is listed.
	 */
	readonly index: SavedChildIndex
	/** The project layout the conversation's log lives in. */
	readonly paths: SessionPaths
	/** The conversation whose turns spawned the children being looked for. */
	readonly session: SessionLocator
	readonly maxChildren?: number
	readonly log?: Logger
}

/** One child as the parent's log records it, plus where its own log is. */
export interface SavedChild extends ChildSessionSummary {
	/** `<parent-session-dir>/subagents/<child-id>.jsonl`, derived from checked ids, never from `path`. */
	readonly logPath: string
}

/**
 * Up to `limit` of a conversation's children, newest first.
 *
 * The parent's log is the record of which children it spawned
 * (`child_session_spawned`) and how each one ended (`child_session_ended`);
 * the index derives {@link ChildSessionSummary} from exactly those records.
 * The parent's log is refreshed first. A refresh that fails is reported and
 * the index is asked anyway: a listing that is one child short is better than
 * none, and the next refresh catches up.
 *
 * Nothing here writes a log, a meta file or a session directory. The only
 * write is the refresh, which brings the rebuildable index up to date with a
 * log it already derives from.
 */
export async function readSavedChildren(
	scope: SavedChildScope,
	limit: number,
): Promise<readonly SavedChild[]> {
	const sessionId = asSessionId(scope.session.sessionId)
	try {
		await scope.index.refresh({
			slug: scope.paths.slug,
			logPath: scope.paths.sessionLog(scope.session),
			sessionId,
		})
	} catch (error) {
		scope.log?.warn('The conversation log could not be refreshed in the session index', {
			'namzu.subagent.replay.session_id': sessionId,
			'namzu.subagent.replay.error': errorMessage(error),
		})
	}
	const children = [...(await scope.index.listChildren(sessionId))]
	children.sort((left, right) => sortTime(right.spawnedAt) - sortTime(left.spawnedAt))
	const found: SavedChild[] = []
	for (const child of children.slice(0, Math.max(0, limit))) {
		try {
			found.push({ ...child, logPath: scope.paths.subagentLog(scope.session, child.sessionId) })
		} catch (error) {
			// A child id the layout refuses is not a path to read. Named so the
			// operator can find the record that carried it.
			scope.log?.warn('A saved child names an id the session layout refuses', {
				'namzu.subagent.replay.child_session_id': String(child.sessionId),
				'namzu.subagent.replay.error': errorMessage(error),
			})
		}
	}
	return found
}

/**
 * Every delegated child one conversation's turns spawned, in launch order,
 * bounded to the newest {@link MAX_REPLAYED_CHILDREN}.
 */
export async function listSavedChildren(scope: SavedChildScope): Promise<readonly SavedChild[]> {
	const newestFirst = await readSavedChildren(scope, scope.maxChildren ?? MAX_REPLAYED_CHILDREN)
	return [...newestFirst].reverse()
}

/**
 * Replays saved children into the display shape the live monitor publishes.
 *
 * One monitor for the whole batch, in replay mode: its bounds, its grouping
 * and its projection are the live ones, and its rows carry
 * {@link SubagentActivity.replayed} so no surface offers to act on work that
 * finished in another process.
 */
export async function replaySavedChildren(
	children: readonly SavedChild[],
	log?: Logger,
): Promise<readonly SubagentActivity[]> {
	const monitor = new SubagentActivityMonitor({ replay: true })
	for (const child of children) {
		const evidence = await readChildLog(child, log)
		const ended = child.endedAt !== undefined
		const status = ended ? child.status : evidence.terminal?.status
		const tokens = ended ? child.tokens : evidence.terminal?.tokens
		const completedAt = ended ? timeOf(child.endedAt) : evidence.terminal?.at
		const startedAt = timeOf(child.spawnedAt)
		monitor.replay(
			{
				agentId: evidence.agentId ?? child.kind,
				description: child.description,
				...(evidence.prompt !== undefined ? { prompt: evidence.prompt } : {}),
				...(evidence.model ? { model: evidence.model } : {}),
				sessionId: child.sessionId,
				// The parent turn is the display group a live cohort is keyed by
				// (`workflowId` on a live row is the invoking turn's id), so a saved
				// child groups under the same identity it had while it ran.
				workflowId: child.parentTurnId,
				batchId: child.batch?.batchId ?? `saved:${child.parentTurnId}`,
				// The labels the parent recorded on `child_session_spawned.batch`:
				// unlike a live-only annotation these survive the process, so a
				// saved child comes back under the workflow and phase it ran in.
				...(child.batch?.name ? { workflow: child.batch.name } : {}),
				...(child.batch?.phase ? { phase: child.batch.phase } : {}),
				...(status ? { status: activityStatus(status) } : {}),
				...(tokens !== undefined ? { tokens } : {}),
				...(Number.isFinite(startedAt) ? { startedAt } : {}),
				...(completedAt !== undefined && Number.isFinite(completedAt) ? { completedAt } : {}),
				...(evidence.partial ? { partial: true } : {}),
			},
			evidence.events,
		)
	}
	return monitor.getSnapshot()
}

/** Discovery and replay in one call, for a host that wants the whole list. */
export async function replaySavedChildrenFor(
	scope: SavedChildScope,
): Promise<readonly SubagentActivity[]> {
	return replaySavedChildren(await listSavedChildren(scope), scope.log)
}

/** What one child's own log says, projected for the monitor. */
interface ChildLogEvidence {
	readonly events: readonly SessionEvent[]
	readonly partial: boolean
	readonly agentId?: string
	readonly model?: string
	readonly prompt?: string
	/** The child's last settled turn, for a child whose parent never recorded an ending. */
	readonly terminal?: {
		readonly status: TurnExecutionStatus
		readonly tokens: number
		readonly at: number
	}
}

const LIVE_EVENT_TYPES: ReadonlySet<string> = new Set(SESSION_EVENT_TYPES)

/**
 * One child's log as the events the live monitor projects, and whether all
 * of it could be read.
 *
 * Read tolerantly, once. A tolerant read stops at the first break in the
 * hash chain and says so (`intact: false`), and a torn final line is counted
 * in `tornBytes`, so the read itself tells a damaged log from a short one. A
 * replay that quietly showed four rows of a forty-row session would be the
 * most misleading thing this view could do, so the damage is reported
 * instead: the rows that survive are shown, and the transcript says it is
 * partial.
 *
 * A log that cannot be read AT ALL — a missing file, or a path that is not a
 * file — is the same answer taken to its limit: no rows, and partial. It is
 * not a reason to leave the child out of the listing. The parent's log still
 * records that the child was spawned and how it ended, dropping the row
 * would say this child never existed, and a row that shows the facts it has
 * under a notice saying the record is incomplete is the honest version of the
 * same information.
 */
async function readChildLog(child: SavedChild, log?: Logger): Promise<ChildLogEvidence> {
	let entries: readonly SessionLogEntry[]
	let partial: boolean
	try {
		const read = await readSessionLog(child.logPath, {
			mode: 'tolerant',
			sessionId: child.sessionId,
		})
		entries = read.entries
		partial = !read.intact || read.tornBytes > 0 || read.entries.length === 0
	} catch (error) {
		log?.warn('Saved child log could not be read', {
			'namzu.subagent.replay.child_log': child.logPath,
			'namzu.subagent.replay.error': errorMessage(error),
		})
		return { events: [], partial: true }
	}
	return { ...projectChildLog(entries.map((entry) => entry.record)), partial }
}

/**
 * A child's records as the live stream would have delivered them.
 *
 * Persisted events pass through unchanged: a record IS its event plus the
 * envelope, and the projection reads only the event's own fields. An
 * assistant `message` record stands in for the `text_delta`s that produced it
 * (deltas are ephemeral and never reach a log), with any later
 * `message_replaced` applied first, so a replay shows the answer the parent
 * was given and never a raw one a guardrail or review replaced. Every other
 * record-only type (checkpoints, decisions, audit, compaction) has no row.
 */
export function projectChildLog(
	records: readonly SessionRecord[],
): Omit<ChildLogEvidence, 'partial'> {
	const replacements = new Map<string, unknown>()
	for (const record of records) {
		if (record.type === 'message_replaced') replacements.set(record.targetMessageId, record.content)
	}
	const events: SessionEvent[] = []
	let agentId: string | undefined
	let model: string | undefined
	let prompt: string | undefined
	let terminal: ChildLogEvidence['terminal']
	for (const record of records) {
		switch (record.type) {
			case 'session_started':
				agentId ??= record.agent.id || record.agent.name || undefined
				continue
			case 'message': {
				if (record.role === 'user' && record.kind === 'prompt' && prompt === undefined) {
					const text = messageText(record.content)
					if (text !== undefined) prompt = text
					continue
				}
				if (record.role !== 'assistant' || record.turnId === undefined) continue
				const text = messageText(replacements.get(record.messageId) ?? record.content)
				if (!text) continue
				events.push({
					type: 'text_delta',
					sessionId: record.sessionId,
					turnId: record.turnId,
					iteration: 0,
					messageId: record.messageId,
					text,
				} as SessionEvent)
				continue
			}
			case 'turn_started':
				model ??= record.config.model || undefined
				break
			case 'turn_completed':
				terminal = {
					status: record.settlement.status,
					tokens: record.settlement.usage.totalTokens,
					at: timeOf(record.ts),
				}
				break
			case 'turn_failed':
				terminal = {
					status: 'failed',
					tokens: record.settlement.usage.totalTokens,
					at: timeOf(record.ts),
				}
				break
			default:
				break
		}
		if (LIVE_EVENT_TYPES.has(record.type)) events.push(record as unknown as SessionEvent)
	}
	return {
		events,
		...(agentId ? { agentId } : {}),
		...(model ? { model } : {}),
		...(prompt !== undefined ? { prompt } : {}),
		...(terminal ? { terminal } : {}),
	}
}

/** The plain text of a message body, when it has one. */
function messageText(content: unknown): string | undefined {
	if (typeof content !== 'object' || content === null) return undefined
	const body = (content as { content?: unknown }).content
	return typeof body === 'string' ? body : undefined
}

/**
 * A saved turn status as the display status the monitor projects.
 *
 * `running` survives as `working` rather than being rewritten to a terminal
 * value: a process killed mid-turn genuinely did not record an ending, and
 * claiming one would be a different lie from the one this view exists to
 * avoid. Nothing is attached to the row either way — `replayed` is what says
 * that, on every replayed row regardless of status.
 */
function activityStatus(status: TurnExecutionStatus): SubagentActivityStatus {
	switch (status) {
		case 'idle':
			return 'starting'
		case 'pending':
			return 'queued'
		case 'running':
			return 'working'
		case 'completed':
			return 'completed'
		case 'failed':
			return 'failed'
		case 'cancelled':
			return 'cancelled'
	}
}

/** Milliseconds since the epoch of an ISO timestamp; NaN for a missing or unreadable one. */
export function timeOf(iso: string | undefined): number {
	return iso === undefined ? Number.NaN : Date.parse(iso)
}

/** {@link timeOf} for ordering: an unreadable time sorts as the oldest. */
function sortTime(iso: string | undefined): number {
	const time = timeOf(iso)
	return Number.isFinite(time) ? time : 0
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

import { mkdtemp, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
	DiskSessionLog,
	type MessageId,
	type ProjectId,
	type SessionId,
	type SessionIndex,
	type SessionLease,
	type SessionLocator,
	SessionPaths,
	type SessionRecord,
	type SessionRecordDraft,
	type TurnId,
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTurnId,
	openSessionIndex,
	readSessionLog,
} from '@namzu/sdk'

/**
 * Real session logs for the saved-children readers, written through the same
 * `DiskSessionLog` the kernel writes with, so the hash chain, the turn rules
 * and the record schemas are the production ones.
 */

export const SLUG = '-work-replay'

export function usage(total: number) {
	return {
		promptTokens: total,
		completionTokens: 0,
		totalTokens: total,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

export const ZERO_COST = { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 }

export function settlement(
	status: 'completed' | 'cancelled' | 'failed',
	tokens: number,
	extra: Record<string, unknown> = {},
) {
	return {
		status,
		iterations: 1,
		usage: usage(tokens),
		cost: ZERO_COST,
		durationMs: 10,
		resultSource: 'model' as const,
		abandonedTaskIds: [],
		abandonedJobIds: [],
		...extra,
	}
}

const CONFIG = { model: 'a-model', tokenBudget: 0, timeoutMs: 0 }

/** A scratch `NAMZU_HOME` with one project layout in it. */
export interface LogHome {
	readonly root: string
	readonly home: string
	readonly paths: SessionPaths
	readonly projectId: ProjectId
	readonly index: () => Promise<SessionIndex>
}

export async function logHome(): Promise<LogHome> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-subagent-logs-')))
	const home = join(root, 'home')
	const paths = new SessionPaths({ home, slug: SLUG })
	return {
		root,
		home,
		paths,
		projectId: generateProjectId(),
		index: () => openSessionIndex({ home, backend: 'scan' }),
	}
}

/** One writer over one log, with the lease already taken. */
export class LogWriter {
	private constructor(
		readonly log: DiskSessionLog,
		private readonly lease: SessionLease,
	) {}

	static async open(paths: SessionPaths, locator: SessionLocator): Promise<LogWriter> {
		const log = DiskSessionLog.at(paths, locator)
		const lease = await log.claim({ holder: 'fixture', ttlMs: 60_000 })
		if (!lease) throw new Error('fixture could not take the log lease')
		return new LogWriter(log, lease)
	}

	append(draft: SessionRecordDraft) {
		return this.log.append(this.lease, draft)
	}

	async beginTurn(turnId: TurnId, prompt: string): Promise<MessageId> {
		const userMessageId = generateMessageId()
		await this.log.beginTurn(this.lease, { turnId, userMessageId, config: CONFIG })
		await this.append({
			type: 'message',
			turnId,
			messageId: userMessageId,
			role: 'user',
			kind: 'prompt',
			content: { role: 'user', content: prompt },
		} as SessionRecordDraft)
		return userMessageId
	}

	async completeTurn(turnId: TurnId, result: string, tokens: number): Promise<void> {
		await this.append({
			type: 'turn_completed',
			turnId,
			result,
			stopReason: 'end_turn',
			settlement: settlement('completed', tokens),
		} as SessionRecordDraft)
	}
}

/** A parent conversation with one open or closed turn to spawn children under. */
export async function parentSession(
	fixture: LogHome,
	prompt = 'Review the release',
): Promise<{
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly writer: LogWriter
}> {
	const sessionId = generateSessionId()
	const writer = await LogWriter.open(fixture.paths, { sessionId })
	await writer.append({
		type: 'session_started',
		projectId: fixture.projectId,
		cwd: '/work/replay',
		agent: { id: 'namzu', name: 'namzu' },
	} as SessionRecordDraft)
	const turnId = generateTurnId()
	await writer.beginTurn(turnId, prompt)
	return { sessionId, turnId, writer }
}

export interface ChildSpec {
	readonly description: string
	readonly batch?: { readonly batchId: string; readonly name: string; readonly phase?: string }
}

/** Records one child's spawn in the parent's log and opens the child's own log. */
export async function spawnChild(
	fixture: LogHome,
	parent: { readonly sessionId: SessionId; readonly turnId: TurnId; readonly writer: LogWriter },
	spec: ChildSpec,
	agentId = 'reviewer',
): Promise<{
	readonly sessionId: SessionId
	readonly writer: LogWriter
	readonly toolCallId: string
}> {
	const sessionId = generateSessionId()
	const toolCallId = `toolu_${sessionId.slice(0, 8)}`
	await parent.writer.append({
		type: 'child_session_spawned',
		turnId: parent.turnId,
		childSessionId: sessionId,
		toolCallId,
		kind: 'agent_spawn',
		description: spec.description,
		path: `subagents/${sessionId}.jsonl`,
		...(spec.batch ? { batch: spec.batch } : {}),
	} as SessionRecordDraft)
	const writer = await LogWriter.open(fixture.paths, {
		sessionId,
		ancestors: [parent.sessionId],
	})
	await writer.append({
		type: 'session_started',
		projectId: fixture.projectId,
		cwd: '/work/replay',
		agent: { id: agentId, name: agentId },
		parent: {
			sessionId: parent.sessionId,
			turnId: parent.turnId,
			toolCallId,
			rootSessionId: parent.sessionId,
			depth: 1,
			kind: 'agent_spawn',
		},
	} as SessionRecordDraft)
	return { sessionId, writer, toolCallId }
}

/** Records a child's ending in the parent's log. */
export async function endChild(
	parent: { readonly turnId: TurnId; readonly writer: LogWriter },
	childSessionId: SessionId,
	status: 'completed' | 'failed' | 'cancelled',
	tokens: number,
	inTurn = true,
): Promise<void> {
	await parent.writer.append({
		type: 'child_session_ended',
		...(inTurn ? { turnId: parent.turnId } : {}),
		childSessionId,
		status,
		usage: usage(tokens),
		cost: ZERO_COST,
	} as SessionRecordDraft)
}

/** One delegated child's log, as a test reads it back: its first turn and how that turn ended. */
export interface ChildTurnRecords {
	readonly logPath: string
	readonly started?: Extract<SessionRecord, { type: 'turn_started' }>
	readonly terminal?: Extract<SessionRecord, { type: 'turn_completed' | 'turn_failed' }>
}

/**
 * Every child session log under `home`: each `<id>.jsonl` inside a
 * `subagents/` directory, at any depth, read tolerantly.
 */
export async function childTurnRecords(home: string): Promise<ChildTurnRecords[]> {
	const entries = await readdir(home, { recursive: true, encoding: 'utf8' }).catch(() => [])
	const logs = entries
		.filter((entry) => entry.endsWith('.jsonl') && basename(dirname(entry)) === 'subagents')
		.map((entry) => join(home, entry))
		.sort()
	const found: ChildTurnRecords[] = []
	for (const logPath of logs) {
		const read = await readSessionLog(logPath, { mode: 'tolerant' })
		let started: ChildTurnRecords['started']
		let terminal: ChildTurnRecords['terminal']
		for (const { record } of read.entries) {
			if (record.type === 'turn_started') started ??= record
			if (record.type === 'turn_completed' || record.type === 'turn_failed') terminal ??= record
		}
		found.push({ logPath, ...(started ? { started } : {}), ...(terminal ? { terminal } : {}) })
	}
	return found
}

import { type SessionIndex, asSessionId, isTerminalStatus } from '@namzu/sdk'

import {
	DEFAULT_AGENT_PHASE,
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
	type SubagentActivityStatus,
} from './activity.js'
import {
	MAX_CONSIDERED_CHILDREN,
	type SavedChildScope,
	readSavedChildren,
	timeOf,
} from './replay.js'

/** Longest a batch's display name gets before it is clipped, matching a conversation title's own bound. */
const MAX_BATCH_NAME_CODE_UNITS = 60

/**
 * Batches shown newest first, bounded: a page an operator can actually read,
 * plus an honest count of what did not fit rather than a listing that quietly
 * grows with the whole estate.
 */
export const MAX_LISTED_BATCHES = 20

/**
 * One row of `/agents batches`: every child one parent turn launched, whether
 * that turn is still going or long settled.
 *
 * {@link id} is the parent turn id every one of its children names —
 * `workflowId` on a live {@link SubagentActivity}, `parentTurnId` on a saved
 * {@link import('@namzu/sdk').ChildSessionSummary} — so a row from either
 * source addresses the same batch the same way.
 */
export interface Batch {
	readonly id: string
	readonly name: string
	readonly startedAt: number
	readonly phases: readonly string[]
	readonly agentsDone: number
	readonly agentsTotal: number
	readonly tokensTotal: number
	readonly elapsedMs: number
	/**
	 * Read from the live monitor because at least one child is still going.
	 *
	 * Never true for a row this module read from the session index: a finished
	 * batch is reported from the parent's log, the durable record, and not from
	 * whatever the live monitor still happens to retain of it — see
	 * {@link listSavedBatches}.
	 */
	readonly live: boolean
}

/** What `/agents batches` shows: at most {@link MAX_LISTED_BATCHES} rows and a count of the rest. */
export interface BatchListing {
	readonly batches: readonly Batch[]
	readonly omitted: number
}

/** The honest empty answer for `/agents batches`. */
export const NO_BATCHES_MESSAGE =
	'No batches yet. This conversation has not delegated any work, or none of it is still recorded.'

function isTerminalActivityStatus(status: SubagentActivityStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** A phase name per distinct phase a group's members declared, in launch order. */
function orderedPhaseNames(members: readonly SubagentActivity[]): readonly string[] {
	const seen = new Set<string>()
	const ordered: string[] = []
	for (const agent of [...members].sort(
		(left, right) => left.phaseSequence - right.phaseSequence,
	)) {
		if (seen.has(agent.phase)) continue
		seen.add(agent.phase)
		ordered.push(agent.phase)
	}
	return ordered
}

/** A conversation-title-style clip: one line, {@link MAX_BATCH_NAME_CODE_UNITS} wide, or the neutral default. */
function batchName(text: string | undefined): string {
	const oneLine = text?.replace(/\s+/g, ' ').trim()
	if (!oneLine) return DEFAULT_AGENT_WORKFLOW
	return oneLine.length > MAX_BATCH_NAME_CODE_UNITS
		? `${oneLine.slice(0, MAX_BATCH_NAME_CODE_UNITS - 1)}…`
		: oneLine
}

/**
 * Parent turns THIS PROCESS is still tracking, one row per turn id that has at
 * least one non-terminal child.
 *
 * A group every one of whose members has already settled is left out: that
 * batch is better read from the session index, where the parent's log is the
 * record of fact, and reporting it here too would be a second, competing
 * account of a batch this function has no fresher information about.
 * {@link combineBatches} applies the same rule from the other side, by
 * dropping a saved row whose id is live.
 *
 * The row's name is the group's own `workflow` label, an explicit annotation
 * when the delegating host supplied one and the neutral default otherwise.
 */
export function liveBatches(agents: readonly SubagentActivity[], now: number): readonly Batch[] {
	const groups = new Map<string, SubagentActivity[]>()
	for (const agent of agents) {
		if (agent.replayed) continue
		const group = groups.get(agent.workflowId)
		if (group) group.push(agent)
		else groups.set(agent.workflowId, [agent])
	}
	const batches: Batch[] = []
	for (const [id, members] of groups) {
		if (members.every((agent) => isTerminalActivityStatus(agent.status))) continue
		const startedAt = Math.min(...members.map((agent) => agent.startedAt))
		batches.push({
			id,
			name: batchName(members[0]?.workflow),
			startedAt,
			phases: orderedPhaseNames(members),
			agentsTotal: members.length,
			agentsDone: members.filter((agent) => isTerminalActivityStatus(agent.status)).length,
			tokensTotal: members.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0),
			elapsedMs: Math.max(0, now - startedAt),
			live: true,
		})
	}
	return batches
}

/** A saved-children scope that can also name a parent turn by its opening words. */
export interface SavedBatchScope extends Omit<SavedChildScope, 'index'> {
	readonly index: Pick<SessionIndex, 'refresh' | 'listChildren' | 'listTurns'>
}

/**
 * Batches read from the session index, one row per parent turn the index
 * finds children under.
 *
 * Cheap by design: the rows come from `listChildren` and `listTurns`, which
 * the index derives from the parent's own records — never from a child's log.
 * A full replay (the child logs included) happens once an operator actually
 * opens one of these rows, not while building the list every one of them
 * appears on. Bounded to the newest {@link MAX_CONSIDERED_CHILDREN} children.
 *
 * Named from the `batch.name` the parent recorded when it spawned the
 * children (`child_session_spawned.batch`), or, for work that carried no
 * label, from the opening words of the parent turn itself (`userPreview`).
 * Phases are the recorded `batch.phase` labels in launch order, or the
 * neutral default when none was recorded.
 */
export async function listSavedBatches(scope: SavedBatchScope): Promise<readonly Batch[]> {
	const children = [...(await readSavedChildren(scope, MAX_CONSIDERED_CHILDREN))].reverse()
	if (children.length === 0) return []
	const groups = new Map<string, (typeof children)[number][]>()
	for (const child of children) {
		const group = groups.get(child.parentTurnId)
		if (group) group.push(child)
		else groups.set(child.parentTurnId, [child])
	}
	const previews = await turnPreviews(scope)
	const batches: Batch[] = []
	for (const [id, members] of groups) {
		const started = members.map((child) => timeOf(child.spawnedAt)).filter(Number.isFinite)
		const ended = members.map((child) => timeOf(child.endedAt)).filter(Number.isFinite)
		const startedAt = started.length > 0 ? Math.min(...started) : 0
		const finishedAt = ended.length > 0 ? Math.max(...ended) : startedAt
		const label = members
			.map((child) => child.batch?.name?.trim())
			.find((name) => name && name !== DEFAULT_AGENT_WORKFLOW)
		const phases = [
			...new Set(
				members
					.map((child) => child.batch?.phase?.trim())
					.filter((phase): phase is string => !!phase),
			),
		]
		batches.push({
			id,
			name: batchName(label ?? previews.get(id)),
			startedAt,
			phases: phases.length > 0 ? phases : [DEFAULT_AGENT_PHASE],
			agentsTotal: members.length,
			agentsDone: members.filter((child) => isTerminalStatus(child.status)).length,
			tokensTotal: members.reduce((sum, child) => sum + child.tokens, 0),
			elapsedMs: Math.max(0, finishedAt - startedAt),
			live: false,
		})
	}
	return batches
}

/**
 * Each of the conversation's turns by its opening words. An index that cannot
 * list the turns is not a reason to fail the listing: the rows keep the
 * neutral default name instead.
 */
async function turnPreviews(scope: SavedBatchScope): Promise<ReadonlyMap<string, string>> {
	try {
		const turns = await scope.index.listTurns(asSessionId(scope.session.sessionId))
		return new Map(
			turns.flatMap((turn) => (turn.userPreview ? [[String(turn.id), turn.userPreview]] : [])),
		)
	} catch (error) {
		scope.log?.warn('The parent turns could not be listed for their names', {
			'namzu.subagent.batches.session_id': String(scope.session.sessionId),
			'namzu.subagent.batches.error': error instanceof Error ? error.message : String(error),
		})
		return new Map()
	}
}

/**
 * Merges a conversation's still-running batches with its finished ones into
 * the one list `/agents batches` shows, newest first.
 *
 * A turn id named by both sources keeps its LIVE row and drops the saved one:
 * the live monitor is the fresher account of work this process can still
 * watch directly, and the parent's log for that same turn is still being
 * written — never authority over work its own process is reporting live.
 */
export function combineBatches(live: readonly Batch[], finished: readonly Batch[]): BatchListing {
	const liveIds = new Set(live.map((batch) => batch.id))
	const all = [...live, ...finished.filter((batch) => !liveIds.has(batch.id))].sort(
		(left, right) => right.startedAt - left.startedAt,
	)
	const batches = all.slice(0, MAX_LISTED_BATCHES)
	return { batches, omitted: Math.max(0, all.length - batches.length) }
}

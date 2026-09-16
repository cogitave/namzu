import { join } from 'node:path'

import { isTerminalStatus as isTerminalRunStatus, readRunMessagesIn } from '@namzu/sdk'

import {
	DEFAULT_AGENT_PHASE,
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
	type SubagentActivityStatus,
} from './activity.js'
import { type SavedChildScope, listSavedChildren } from './replay.js'

/** Longest a run's display name gets before it is clipped, matching a conversation title's own bound. */
const MAX_RUN_NAME_CODE_UNITS = 60

/**
 * One row of `/agents runs`: every child launched under one parent turn,
 * whether that turn is still going or long settled.
 *
 * {@link id} is the parent run id every one of its children names —
 * `workflowId` on a live {@link SubagentActivity}, `parentRunId` on a saved
 * {@link import('@namzu/sdk').DelegatedChildRun} — so a row from either
 * source addresses the same run the same way.
 */
export interface OrchestrationRun {
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
	 * Never true for a row this module read from disk: a finished run is
	 * reported from `run.json`, the durable record, and not from whatever the
	 * live monitor still happens to retain of it — see
	 * {@link listSavedOrchestrationRuns}.
	 */
	readonly live: boolean
}

function isTerminalActivityStatus(status: SubagentActivityStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined
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

/** A conversation-title-style clip: one line, `MAX_RUN_NAME_CODE_UNITS` wide, or the neutral default. */
function runName(text: string | undefined): string {
	const oneLine = text?.replace(/\s+/g, ' ').trim()
	if (!oneLine) return DEFAULT_AGENT_WORKFLOW
	return oneLine.length > MAX_RUN_NAME_CODE_UNITS
		? `${oneLine.slice(0, MAX_RUN_NAME_CODE_UNITS - 1)}…`
		: oneLine
}

/**
 * Parent turns THIS PROCESS is still tracking, one row per run id that has at
 * least one non-terminal child.
 *
 * A group every one of whose members has already settled is left out: that
 * run is better read from disk, where `run.json` is the record of fact, and
 * reporting it here too would be a second, competing account of a run this
 * function has no fresher information about than the disk copy already has.
 * Its caller is what applies that rule — see {@link listSavedOrchestrationRuns}'s
 * own doc — by excluding a live id from the disk pass.
 *
 * The row's name is the group's own `workflow` label, an explicit annotation
 * when the delegating host supplied one and the neutral default otherwise —
 * the live case is the ONE place that label is trustworthy, since the
 * process that would know it is the one being asked. A saved run has no such
 * label to read; see {@link listSavedOrchestrationRuns} for what it reports
 * instead.
 */
export function liveOrchestrationRuns(
	agents: readonly SubagentActivity[],
	now: number,
): readonly OrchestrationRun[] {
	const groups = new Map<string, SubagentActivity[]>()
	for (const agent of agents) {
		if (agent.replayed) continue
		const group = groups.get(agent.workflowId)
		if (group) group.push(agent)
		else groups.set(agent.workflowId, [agent])
	}
	const runs: OrchestrationRun[] = []
	for (const [id, members] of groups) {
		if (members.every((agent) => isTerminalActivityStatus(agent.status))) continue
		const startedAt = Math.min(...members.map((agent) => agent.startedAt))
		runs.push({
			id,
			name: runName(members[0]?.workflow),
			startedAt,
			phases: orderedPhaseNames(members),
			agentsTotal: members.length,
			agentsDone: members.filter((agent) => isTerminalActivityStatus(agent.status)).length,
			tokensTotal: members.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0),
			elapsedMs: Math.max(0, now - startedAt),
			live: true,
		})
	}
	return runs
}

/**
 * Finished parent turns read from disk, one row per parent run id
 * {@link listSavedChildren} finds children under.
 *
 * Cheap by design: only `run.json` is read per child, the same evidence
 * {@link listSavedChildren} already surfaces, and the parent turn's OWN
 * `messages.json` for the row's name — never a child's transcript. A full
 * replay (transcript included) happens once an operator actually opens one
 * of these rows, not while building the list every one of them appears on.
 *
 * Named from the parent turn's own first words, read straight from
 * `<sessionsRoot>/<sessionId>/runs/<parentRunId>/messages.json` — a saved
 * child carries no `workflow` label to fall back to instead, because that
 * label is display-only and reaches nowhere durable (see
 * `docs/sdk/delegation-events.md`); the run that opened the turn is the
 * nearest durable stand-in for what it was.
 *
 * Never reports a phase beyond the neutral default: a phase label is exactly
 * as undurable as a workflow label, so nothing on disk can distinguish two
 * saved phases from one.
 */
export async function listSavedOrchestrationRuns(
	scope: SavedChildScope,
): Promise<readonly OrchestrationRun[]> {
	const children = await listSavedChildren(scope)
	const groups = new Map<string, (typeof children)[number][]>()
	for (const child of children) {
		const group = groups.get(child.parentRunId)
		if (group) group.push(child)
		else groups.set(child.parentRunId, [child])
	}
	const runs: OrchestrationRun[] = []
	for (const [id, members] of groups) {
		const started = members.map((child) => child.startedAt).filter(isDefined)
		const ended = members.map((child) => child.endedAt).filter(isDefined)
		const startedAt = started.length > 0 ? Math.min(...started) : 0
		const finishedAt = ended.length > 0 ? Math.max(...ended) : startedAt
		runs.push({
			id,
			name: runName(await parentTurnFirstWords(scope, id)),
			startedAt,
			phases: [DEFAULT_AGENT_PHASE],
			agentsTotal: members.length,
			agentsDone: members.filter(
				(child) => child.status !== undefined && isTerminalRunStatus(child.status),
			).length,
			tokensTotal: members.reduce((sum, child) => sum + (child.totalTokens ?? 0), 0),
			elapsedMs: Math.max(0, finishedAt - startedAt),
			live: false,
		})
	}
	return runs
}

/**
 * The opening line of the user turn that started `parentRunId`, or
 * `undefined` when it cannot be read — a run still in flight has not written
 * `messages.json` yet (see {@link import('@namzu/sdk').RunStore.writeMessages}),
 * and an old or damaged one is not a reason to fail the whole listing.
 */
async function parentTurnFirstWords(
	scope: SavedChildScope,
	parentRunId: string,
): Promise<string | undefined> {
	try {
		const runDir = join(scope.sessionsRoot, scope.sessionId, 'runs', parentRunId)
		const snapshot = await readRunMessagesIn(runDir)
		const messages = snapshot.kind === 'unavailable' ? [] : snapshot.messages
		const first = messages.find(
			(message) => message.role === 'user' && message.source === undefined,
		)
		return first?.role === 'user' ? first.content : undefined
	} catch (error) {
		scope.log?.warn('A saved parent turn could not be read for its name', {
			'namzu.subagent.runs.parent_run_id': parentRunId,
			'namzu.subagent.runs.error': error instanceof Error ? error.message : String(error),
		})
		return undefined
	}
}

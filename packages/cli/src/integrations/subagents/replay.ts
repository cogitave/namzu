import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
	type DelegatedChildRun,
	type Logger,
	type PersistedRunEvent,
	RunDiskStore,
	type RunExecutionStatus,
	readRunEventsIn,
} from '@namzu/sdk'

import {
	type SubagentActivity,
	SubagentActivityMonitor,
	type SubagentActivityStatus,
} from './activity.js'

/**
 * Session directories scanned when looking for a conversation's saved
 * children.
 *
 * Each delegated child is given its OWN session directory, so the children of
 * one parent run are spread across as many of them as the parent launched
 * children. A long-lived project accumulates those, and a scan with no
 * ceiling would grow with the whole estate rather than with the conversation
 * being opened. The scan is one `readdir` per directory and stops here.
 *
 * It is a bound, not a policy. Entries come back in the order the filesystem
 * lists them, so past this many directories WHICH children are found stops
 * being predictable — which is an argument for a prune command, not a
 * substitute for one.
 */
const MAX_SCANNED_SESSION_DIRECTORIES = 2_000

/**
 * Children replayed into one monitor, matching the live monitor's own
 * retention. Replay walks the newest first and stops at this many, so a
 * conversation that delegated thousands of times opens its most recent work
 * instead of its whole history.
 */
const MAX_REPLAYED_CHILDREN = 80

/** Where a conversation's own runs and its children's evidence both live. */
export interface SavedChildScope {
	/** The `sessions/` directory holding this project's session directories. */
	readonly sessionsRoot: string
	/** The conversation whose parent runs own the children being looked for. */
	readonly sessionId: string
	readonly maxChildren?: number
	readonly log?: Logger
}

/**
 * Every delegated child saved under one conversation's parent runs, newest
 * first.
 *
 * Two directory shapes have to meet here. A conversation's own runs are
 * `<sessionsRoot>/<sessionId>/runs/<runId>`, which is where the parent run
 * ids come from after a restart has forgotten them. A child's evidence is
 * `<sessionsRoot>/<childSessionId>/runs/<parentRunId>/children/<childRunId>`,
 * under the child's session and not the parent's — so finding a child means
 * asking every session directory whether it holds a `runs/` entry named after
 * one of this conversation's runs.
 *
 * That ordering is deliberate: one `readdir` per session directory answers
 * the question for all of that directory's children at once, where probing
 * each parent run inside each session directory would multiply the two
 * counts. A child session directory holds exactly one parent run id, so the
 * inner listing runs only where there is something to list.
 *
 * READ-ONLY throughout. Nothing here creates a directory, and in particular
 * nothing binds a `RunDiskStore`, which would mint the run directory it was
 * asked about.
 */
export async function listSavedChildren(
	scope: SavedChildScope,
): Promise<readonly DelegatedChildRun[]> {
	const parentRunIds = new Set(
		await directoryNames(join(scope.sessionsRoot, scope.sessionId, 'runs')),
	)
	if (parentRunIds.size === 0) return []

	const sessionIds = await directoryNames(scope.sessionsRoot)
	const found: DelegatedChildRun[] = []
	for (const sessionId of sessionIds.slice(0, MAX_SCANNED_SESSION_DIRECTORIES)) {
		const runsDir = join(scope.sessionsRoot, sessionId, 'runs')
		for (const runId of await directoryNames(runsDir)) {
			if (!parentRunIds.has(runId)) continue
			try {
				found.push(...(await RunDiskStore.listChildren(runsDir, runId)))
			} catch (error) {
				// One unreadable parent directory is not a reason to report that a
				// conversation delegated nothing. Named so the operator can find it.
				scope.log?.warn('Saved delegated children could not be listed', {
					'namzu.subagent.replay.runs_dir': runsDir,
					'namzu.subagent.replay.parent_run_id': runId,
					'namzu.subagent.replay.error': errorMessage(error),
				})
			}
		}
	}
	// Newest first so the cap keeps the most recent work, then back into launch
	// order, which is the order the cockpit lists a cohort in.
	found.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
	return found.slice(0, scope.maxChildren ?? MAX_REPLAYED_CHILDREN).reverse()
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
	children: readonly DelegatedChildRun[],
	log?: Logger,
): Promise<readonly SubagentActivity[]> {
	const monitor = new SubagentActivityMonitor({ replay: true })
	for (const child of children) {
		const evidence = await readChildEvidence(child, log)
		monitor.replay(
			{
				agentId: child.agentId ?? child.agentName ?? child.id,
				description: child.agentName ?? child.agentId ?? child.id,
				...(child.model ? { model: child.model } : {}),
				runId: child.id,
				// A parent run is the display group a live cohort is keyed by, and
				// the batch a child belonged to is not recorded on disk. Grouping
				// every saved child of one parent run together is the coarsest
				// answer that is still true; splitting them by anything else would
				// invent a boundary the evidence does not have.
				workflowId: child.parentRunId,
				batchId: `saved:${child.parentRunId}`,
				...(child.status ? { status: activityStatus(child.status) } : {}),
				...(child.totalTokens !== undefined ? { tokens: child.totalTokens } : {}),
				...(child.startedAt !== undefined ? { startedAt: child.startedAt } : {}),
				...(child.endedAt !== undefined ? { completedAt: child.endedAt } : {}),
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

/**
 * One child's durable events, and whether all of them could be read.
 *
 * Read strictly first, then tolerantly. The strict pass is not about
 * refusing damaged evidence — it is the only way to LEARN that the evidence
 * is damaged, because the tolerant reader's whole job is to skip a torn
 * record and carry on, which leaves a truncated transcript indistinguishable
 * from a short one. A replay that quietly showed four rows of a forty-row run
 * would be the most misleading thing this view could do, so the damage is
 * reported instead: the rows that survive are shown, and the transcript says
 * it is partial.
 *
 * A transcript that cannot be read AT ALL — an unreadable file, or a
 * compaction archive beside it that the tolerant read cannot skip past
 * either — is the same answer taken to its limit: no rows, and partial. It is
 * not a reason to leave the child out of the listing. `run.json` still
 * records what the run did and when, dropping the row would say this child
 * never existed, and a row that shows the facts it has under a notice saying
 * the record is incomplete is the honest version of the same information.
 */
async function readChildEvidence(
	child: DelegatedChildRun,
	log?: Logger,
): Promise<{ readonly events: readonly PersistedRunEvent[]; readonly partial: boolean }> {
	try {
		return { events: await readRunEventsIn(child.dir, { integrity: 'strict' }), partial: false }
	} catch {
		// Falls through to the tolerant read below.
	}
	try {
		return { events: await readRunEventsIn(child.dir), partial: true }
	} catch (error) {
		log?.warn('Saved child transcript could not be read', {
			'namzu.subagent.replay.child_dir': child.dir,
			'namzu.subagent.replay.error': errorMessage(error),
		})
		return { events: [], partial: true }
	}
}

/**
 * A saved run status as the display status the monitor projects.
 *
 * `running` survives as `working` rather than being rewritten to a terminal
 * value: a process killed mid-run genuinely did not record an ending, and
 * claiming one would be a different lie from the one this view exists to
 * avoid. Nothing is attached to the row either way — `replayed` is what says
 * that, on every replayed row regardless of status.
 */
function activityStatus(status: RunExecutionStatus): SubagentActivityStatus {
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

/** Directory entries by name; an absent directory lists as nothing. */
async function directoryNames(dir: string): Promise<readonly string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true })
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	} catch {
		return []
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

import { join } from 'node:path'
import { EmergencySaveManager } from '../../../manager/run/emergency.js'
import { RunDiskStore } from '../../../store/run/disk.js'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId } from '../../../types/ids/index.js'
import type { Message } from '../../../types/message/index.js'
import type { Mutation, ReplayAttribution } from '../../../types/run/replay.js'
import type { Logger } from '../../../utils/logger.js'
import { projectEmergencyToCheckpoint } from '../checkpoint.js'
import { applyMutations } from './mutate.js'

export type CheckpointSelector = CheckpointId | 'latest' | 'emergency'

export interface PrepareReplayInput {
	/** Directory that contains `<runId>/` for the source run. */
	baseDir: string
	/** Source run to fork from. */
	runId: RunId
	/** Which checkpoint to fork at. */
	fromCheckpoint: CheckpointSelector
	/** Optional mutations applied at the fork point before the caller hands state to `query()`. */
	mutate?: Mutation[]
	/**
	 * Directory that holds emergency dumps. Required only when `fromCheckpoint`
	 * is `'emergency'`; conventionally sibling of `baseDir` (the `.namzu/emergency`
	 * folder), but left explicit so callers with non-default layouts can redirect.
	 */
	emergencyDir?: string
	logger?: Logger
}

export interface PreparedReplayState {
	/**
	 * Message history at the fork point, with mutations applied. Seed this
	 * as the new run's initial messages and pass `sourceCheckpoint.id` as
	 * `resumeFromCheckpoint` when you call `query()`.
	 */
	messages: Message[]
	/** The checkpoint the replay forks from (already projected if emergency). */
	sourceCheckpoint: IterationCheckpoint
	/**
	 * Attribution to stamp on the replay run once it is created. The caller
	 * sets `Run.replayOf = buildAttribution(prepared, replayedAt)` on the
	 * new `RunPersistence` before persisting the first time.
	 */
	attribution: ReplayAttribution
}

/**
 * Produce the state materials needed to execute a replay run — the mutated
 * message history, the resolved source checkpoint, and the replay
 * attribution record. Pure read; does not touch the run store beyond
 * reading the source run's checkpoint files.
 *
 * This is the state-preparation half of the replay primitive. The
 * caller is expected to thread the returned `messages` +
 * `sourceCheckpoint.id` into `query({ resumeFromCheckpoint, messages,
 * ... })` and stamp `Run.replayOf = prepared.attribution` on the resulting
 * run. The end-to-end `replay()` entry that does all of this in one call
 * is a follow-up session (`ReplayEnvironment` shape).
 *
 * See `ses_005-deterministic-replay/design.md` §3.1.
 */
export async function prepareReplayState(input: PrepareReplayInput): Promise<PreparedReplayState> {
	const sourceCheckpoint = await resolveCheckpoint(input)
	const mutations = input.mutate ?? []
	const messages = applyMutations(sourceCheckpoint.messages, mutations)

	const attribution: ReplayAttribution = {
		sourceRunId: input.runId,
		fromCheckpointId: sourceCheckpoint.id,
		mutations,
		replayedAt: Date.now(),
	}

	return { messages, sourceCheckpoint, attribution }
}

async function resolveCheckpoint(input: PrepareReplayInput): Promise<IterationCheckpoint> {
	if (input.fromCheckpoint === 'emergency') {
		return resolveEmergency(input)
	}
	const store = new RunDiskStore({ baseDir: input.baseDir, logger: input.logger })
	await store.initRun(input.runId)

	if (input.fromCheckpoint === 'latest') {
		const all = await store.listCheckpoints()
		if (all.length === 0) {
			throw new Error(`No checkpoints found for run ${input.runId} in ${input.baseDir}`)
		}
		return [...all].sort((a, b) => b.iteration - a.iteration)[0] as IterationCheckpoint
	}

	const checkpoint = await store.readCheckpoint(input.fromCheckpoint)
	if (!checkpoint) {
		throw new Error(`Checkpoint ${input.fromCheckpoint} not found for run ${input.runId}`)
	}
	return checkpoint
}

async function resolveEmergency(input: PrepareReplayInput): Promise<IterationCheckpoint> {
	if (!input.emergencyDir) {
		throw new Error(
			"fromCheckpoint: 'emergency' requires an `emergencyDir` — conventionally sibling of baseDir",
		)
	}
	const path = join(input.emergencyDir, `${input.runId}.json`)
	try {
		const dump = EmergencySaveManager.loadSave(path)
		return projectEmergencyToCheckpoint(dump)
	} catch (err) {
		throw new Error(`No emergency dump found for run ${input.runId} at ${path}`, { cause: err })
	}
}

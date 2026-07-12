import { join } from 'node:path'
import { repairDanglingMessages } from '../../../compaction/dangling.js'
import { EmergencySaveManager } from '../../../manager/run/emergency.js'
import { RunDiskStore } from '../../../store/run/disk.js'
import type {
	CheckpointId,
	IterationCheckpoint,
	PendingDecision,
} from '../../../types/hitl/index.js'
import type { DecisionRequestId, RunId } from '../../../types/ids/index.js'
import type { Message } from '../../../types/message/index.js'
import type { Mutation, ReplayAttribution } from '../../../types/run/replay.js'
import type { Logger } from '../../../utils/logger.js'
import { projectEmergencyToCheckpoint } from '../checkpoint.js'
import { decisionOwnsToolBlock } from '../decision/pending.js'
import { applyMutations } from './mutate.js'

export type CheckpointSelector = CheckpointId | 'latest' | 'emergency'

export interface PrepareReplayInput {
	/** Directory that contains `<runId>/` for the source run. */
	baseDir: string
	/** Source run to fork from. */
	runId: RunId
	/**
	 * The source run's parent, when the source is a CHILD run. Load-bearing for the same
	 * reason it is on `DecisionLocator`: a child's record lives at
	 * `baseDir/<parentRunId>/children/<runId>`, and without it the store resolves
	 * `baseDir/<runId>` — a directory it then CREATES, empty, and finds no checkpoints in.
	 */
	parentRunId?: RunId
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
	/**
	 * Set when the source checkpoint was parked on a live decision that this fork did
	 * NOT carry across.
	 *
	 * A replay is a fork, not a resume. The decision belongs to the original run — its
	 * resume token is scoped to that run, and this fork has no authority to redeem it —
	 * so the fork gets a timeline in which the human never answered and the tool never
	 * ran, which is what the repaired history says. That is a coherent thing to want
	 * (it is how you replay "what if I had said no?"), and it is a terrible thing to get
	 * by accident. Surfaced so the caller knows which one happened.
	 *
	 * To *resume* the decision instead of forking away from it, redeem the token:
	 * {@link import('../decision/resume.js').resumeDecision}.
	 */
	discardedPendingDecision?: DecisionRequestId
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
	const mutated = applyMutations(sourceCheckpoint.messages, mutations)
	// Repair after mutations: a mutation may leave a tool call unmatched (repair
	// synthesizes an error result) or append a result at the tail (repair
	// canonicalizes its placement) so the replayed history is provider-valid.
	//
	// A replay REPAIRS even when the source checkpoint is parked on a live decision, and
	// that is deliberate — a fork is not a resume. The decision, its token and its
	// journal belong to the original run; the fork is a new timeline in which the human
	// never answered and the tool never ran, and the synthesized "tool result missing"
	// is the honest description of it. What the fork must not do is take that silently,
	// so the dropped decision comes back on the result.
	const messages = repairDanglingMessages(mutated)
	const discarded = sourceCheckpoint.pendingDecision

	if (discarded && discarded.state !== 'settled' && discarded.state !== 'cancelled') {
		input.logger?.warn(
			'Replaying from a checkpoint that is parked on a live decision — the decision is NOT carried into the fork',
			{
				runId: input.runId,
				checkpointId: sourceCheckpoint.id,
				requestId: discarded.requestId,
				state: discarded.state,
			},
		)
	}

	const attribution: ReplayAttribution = {
		sourceRunId: input.runId,
		fromCheckpointId: sourceCheckpoint.id,
		mutations,
		replayedAt: Date.now(),
	}

	return {
		messages,
		sourceCheckpoint,
		attribution,
		discardedPendingDecision: discarded?.requestId,
	}
}

/**
 * State-preparation half of a **resume** from a checkpoint. Pure transform:
 * repairs dangling tool pairs ({@link repairDanglingMessages}) so an
 * interrupted run's persisted history is provider-valid, then drops
 * system-role messages — the resume caller pushes fresh system prompts
 * separately, so re-seeding the checkpoint's system messages would duplicate
 * them.
 *
 * **Unless a live decision owns the tool-call block**, in which case the repair is
 * suppressed. This is the ses_017 fix, and it is a parameter rather than a rule the
 * caller has to remember precisely because forgetting it is silent and destructive:
 * `repairDanglingMessages` treats an unexecuted assistant tool call as an interrupted
 * pair and rewrites it into a "[SYSTEM] Tool result missing" placeholder. For a crash
 * that is exactly right. For a **pause** it destroys the call a human was asked to
 * approve, and tells the model the tool failed. The two cases are indistinguishable
 * from the messages alone; only the persisted decision tells them apart, so the
 * decision is what this takes.
 *
 * A caller who passes nothing gets the old behaviour, which is still correct for every
 * checkpoint that has no decision on it.
 *
 * The suppressed history is deliberately provider-INVALID (an assistant tool-call block
 * with no results). That is safe only because the resume dispatcher runs before
 * anything can see it — see
 * {@link import('../decision/dispatch.js').dispatchPendingDecision}. There is no path
 * from here to a provider that does not pass through it.
 *
 * @param checkpointMessages - Messages loaded from the checkpoint being resumed
 * @param pendingDecision - The checkpoint's decision, if it has one
 * @returns System-filtered messages ready to seed the resumed run
 */
export function prepareResumeMessages(
	checkpointMessages: Message[],
	pendingDecision?: PendingDecision,
): Message[] {
	const messages = decisionOwnsToolBlock(pendingDecision)
		? checkpointMessages
		: repairDanglingMessages(checkpointMessages)
	return messages.filter((msg) => msg.role !== 'system')
}

async function resolveCheckpoint(input: PrepareReplayInput): Promise<IterationCheckpoint> {
	if (input.fromCheckpoint === 'emergency') {
		return resolveEmergency(input)
	}
	const store = new RunDiskStore({ baseDir: input.baseDir, logger: input.logger })
	await store.initRun(input.runId, input.parentRunId)

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

import { z } from 'zod'
import type { TokenUsage } from '../common/index.js'
import type { CheckpointId, DecisionRequestId, EmergencySaveId, RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'

/**
 * Pointer to the decision a run is parked on. A pointer, not a copy: the decision (its
 * state, its token, its execution journal) lives on the checkpoint, and duplicating it
 * would create a second source of truth that the first crash leaves disagreeing with
 * the first.
 */
export interface AwaitingDecisionRef {
	checkpointId: CheckpointId
	requestId: DecisionRequestId
}

export interface EmergencySaveData {
	id: EmergencySaveId
	runId: RunId
	messages: Message[]
	tokenUsage: TokenUsage
	currentIteration: number
	startedAt: number
	savedAt: number
	processSignal: string
	lastError?: string

	/**
	 * Set when the dump was taken while the run was awaiting a decision.
	 *
	 * The dump carries the run, not the checkpoint, so it does NOT carry the decision —
	 * and a history with an unowned dangling tool call is exactly what
	 * `repairDanglingMessages` rewrites into "tool result missing". Projecting such a
	 * dump would therefore destroy the decision the run was parked on, which is the
	 * ses_017 bug arriving through a third door. `projectEmergencyToCheckpoint` refuses
	 * when this is set, and names the checkpoint that DOES have the decision.
	 */
	awaitingDecision?: AwaitingDecisionRef
}

export const EmergencySaveConfigSchema = z.object({
	enabled: z.boolean().default(true),
	emergencyDir: z.string().optional(),
})

export type EmergencySaveConfig = z.infer<typeof EmergencySaveConfigSchema>

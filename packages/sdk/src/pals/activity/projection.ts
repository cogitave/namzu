import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SessionLogEntry } from '../../store/session-log/chain.js'
import { isEntityId } from '../../utils/id.js'
import type { PalActivityFact, PalActivityFactType } from './types.js'

const activityId = z.custom<NonNullable<PalActivityFact['activityId']>>((value) =>
	isEntityId(value, 'activity'),
)
const checkpointId = z.custom<NonNullable<PalActivityFact['checkpointId']>>((value) =>
	isEntityId(value, 'checkpoint'),
)
const toolUseId = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[A-Za-z0-9_.:-]+$/)
const activityCreated = z.object({
	activityId,
	activityType: z.enum(['tool_call', 'llm_turn', 'sub_agent', 'shell']),
})
const activityUpdated = z.object({
	activityId,
	status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped']),
})

/** Raw journal payloads never escape this closed projection. Unknown types are omitted. */
export function projectPalActivity(
	entry: SessionLogEntry,
	scopeHash: string,
): PalActivityFact | null {
	const { record, pointer } = entry
	let fields: Partial<PalActivityFact>
	switch (record.type) {
		case 'turn_started':
		case 'turn_resuming':
			fields = { status: 'running' }
			break
		case 'turn_paused':
			fields = { checkpointId: checkpointId.parse(record.checkpointId) }
			break
		case 'turn_completed':
			fields = { status: z.enum(['completed', 'cancelled']).parse(record.settlement.status) }
			break
		case 'turn_failed':
			fields = { status: 'failed' }
			break
		case 'activity_created':
			fields = { ...activityCreated.parse(record), status: 'pending' }
			break
		case 'activity_updated':
			fields = activityUpdated.parse(record)
			break
		case 'tool_executing':
			fields = { toolUseId: toolUseId.parse(record.toolUseId), status: 'running' }
			break
		case 'tool_completed':
			fields = {
				toolUseId: toolUseId.parse(record.toolUseId),
				status: z.boolean().parse(record.isError) ? 'failed' : 'completed',
			}
			break
		case 'tool_review_requested':
			fields = {}
			break
		case 'tool_review_completed':
			fields = {
				reviewDecision: z.enum(['approved', 'modified', 'rejected']).parse(record.decision),
			}
			break
		case 'checkpoint_created':
			fields = { checkpointId: checkpointId.parse(record.checkpointId) }
			break
		default:
			return null
	}
	return Object.freeze({
		id: createHash('sha256')
			.update(JSON.stringify(['pal-activity/1', scopeHash, pointer]))
			.digest('hex'),
		type: record.type as PalActivityFactType,
		sessionId: record.sessionId,
		...('turnId' in record ? { turnId: record.turnId } : {}),
		seq: record.seq,
		generation: record.gen,
		at: record.ts,
		...fields,
	})
}

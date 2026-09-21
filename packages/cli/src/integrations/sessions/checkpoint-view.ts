import type { CheckpointId, CheckpointLogView, CheckpointScope, SessionLog } from '@namzu/sdk'

/**
 * What a checkpoint store asks of the session log it protects, answered by
 * reading that log strictly.
 *
 * The disk checkpoint store verifies a checkpoint against the log before a
 * restore (the record at `throughSeq` still hashes the same, and the document
 * hashes to its `checkpoint_written.docSha256`) and never prunes one an open
 * decision names. A resume in this process builds the store over the same log
 * the turn appends to.
 */
export function sessionLogCheckpointView(
	log: Pick<SessionLog, 'read' | 'sessionId'>,
): CheckpointLogView {
	const owns = (scope: CheckpointScope) => scope.sessionId === log.sessionId
	return {
		async verifyThrough(scope, throughSeq, throughSha256) {
			if (!owns(scope)) return false
			for await (const { pointer } of log.read({ mode: 'strict', throughSeq })) {
				if (pointer.seq === throughSeq) return pointer.sha256 === throughSha256
			}
			return false
		},
		async writtenDocSha256(scope, checkpointId) {
			if (!owns(scope)) return null
			let found: string | null = null
			for await (const { record } of log.read({ mode: 'strict' })) {
				if (record.type === 'checkpoint_written' && record.checkpointId === checkpointId) {
					found = record.docSha256
				}
			}
			return found
		},
		async openDecisionCheckpoints(scope) {
			const open = new Map<string, CheckpointId>()
			if (!owns(scope)) return []
			for await (const { record } of log.read({ mode: 'strict' })) {
				if (record.type === 'decision_requested') open.set(record.decisionId, record.checkpointId)
				else if (record.type === 'decision_resolved' || record.type === 'decision_expired')
					open.delete(record.decisionId)
			}
			return [...open.values()]
		},
	}
}

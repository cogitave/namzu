import type { SessionLog } from '../../store/session-log/index.js'
import { NamzuError } from '../../types/errors/index.js'
import type { ProjectId, SessionId, TenantId, TopicId } from '../../types/ids/index.js'

/** The complete owner a caller says a session log has. */
export interface SessionLogAttribution {
	readonly sessionId: SessionId
	readonly projectId: ProjectId
	readonly tenantId: TenantId
	readonly topicId: TopicId
}

/**
 * Refuse a session owned by another scope before reading its history or
 * checkpoints. Call again while holding its writer lease before a new turn:
 * an empty log seen before the claim may have been opened by another writer.
 *
 * Older logs can omit tenantId/topicId in their schema. They remain readable,
 * but cannot be continued or forked under a guessed owner.
 * Returns false for an unopened log when `requireStarted` is not set.
 */
export async function assertSessionLogAttribution(
	log: SessionLog,
	scope: SessionLogAttribution,
	options: { readonly requireStarted?: boolean } = {},
): Promise<boolean> {
	const requiredFields = ['sessionId', 'projectId', 'tenantId', 'topicId'] as const
	const missingFields = requiredFields.filter(
		(field) => typeof scope[field] !== 'string' || scope[field] === '',
	)
	if (missingFields.length > 0) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `A session owner scope requires ${missingFields.join(', ')}.`,
			details: { fields: missingFields },
		})
	}
	if (log.sessionId !== scope.sessionId) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `The session log belongs to session ${log.sessionId}, not ${scope.sessionId}.`,
			details: { fields: ['sessionId'] },
		})
	}

	const opened = (await log.readAll({ throughSeq: 1 })).entries[0]?.record
	if (!opened && !options.requireStarted) return false
	if (!opened) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `Session ${scope.sessionId} has no session_started owner record.`,
			details: { fields: ['sessionId'] },
		})
	}
	if (opened.type !== 'session_started') {
		throw new NamzuError({
			code: 'invalid_config',
			message: `Session ${scope.sessionId} has no session_started owner record.`,
			details: { fields: ['sessionId'] },
		})
	}

	const fields: string[] = []
	if (opened.sessionId !== scope.sessionId) fields.push('sessionId')
	if (opened.projectId !== scope.projectId) fields.push('projectId')
	if (opened.tenantId === undefined || opened.tenantId !== scope.tenantId) {
		fields.push('tenantId')
	}
	if (opened.topicId === undefined || opened.topicId !== scope.topicId) {
		fields.push('topicId')
	}
	if (fields.length === 0) return true

	throw new NamzuError({
		code: 'invalid_config',
		message: `Session ${scope.sessionId} is not opened under the supplied ${fields.join(', ')} scope.`,
		details: { fields },
	})
}

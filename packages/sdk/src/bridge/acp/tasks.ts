import type { AcpTaskUpdate } from '../../types/acp/index.js'
import type { SessionEvent } from '../../types/session/events.js'

/** Project only the addressed session's planning rows, without task descriptions or metadata. */
export function toAcpTaskUpdate(event: SessionEvent, sessionId: string): AcpTaskUpdate | null {
	if (
		(event.type !== 'task_created' && event.type !== 'task_updated') ||
		event.sessionId !== sessionId
	)
		return null
	return {
		sessionId,
		task: {
			taskId: event.taskId,
			subject: event.subject,
			status: event.status,
			blockedBy: [...(event.blockedBy ?? [])],
			...(event.owner === undefined ? {} : { owner: event.owner }),
			...(event.activeForm ? { activeForm: event.activeForm } : {}),
		},
		...(event.type === 'task_updated' && event.deleted === true ? { deleted: true } : {}),
	}
}

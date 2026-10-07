import { type ThreadState, applyEvent } from '../shared/projection.js'
import type { DesktopEvent } from '../shared/protocol.js'

export type AttachmentPreviewEvent = Extract<DesktopEvent, { kind: 'attachment-previews-evicted' }>

/** Retire known display copies even when their tab belongs to another pane/window. */
export function applyCachedAttachmentPreviewEviction(
	threads: Record<string, ThreadState>,
	event: AttachmentPreviewEvent,
): Record<string, ThreadState> {
	const previous = threads[event.sessionId]
	if (!previous) return threads
	const next = applyEvent(previous, event)
	return next === previous ? threads : { ...threads, [event.sessionId]: next }
}

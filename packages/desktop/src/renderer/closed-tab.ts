import { type ThreadState, applyEvent } from '../shared/projection.js'
import type { DesktopEvent } from '../shared/protocol.js'

/**
 * What a conversation whose tab is closed keeps of the events it still gets:
 * whether it is running, and how full it is. The ring is then right when the
 * conversation is opened again. A turn that ends takes a compaction note with
 * it, so a closed tab never reopens on a stale "Compacting the conversation".
 */
export function applyClosedTabEvent(thread: ThreadState, event: DesktopEvent): ThreadState {
	if (event.kind === 'usage') return applyEvent(thread, event)
	if (event.kind === 'state')
		return {
			...thread,
			running: event.running,
			...(event.running ? {} : { compaction: undefined }),
		}
	return thread
}

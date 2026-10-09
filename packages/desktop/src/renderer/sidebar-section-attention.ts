import {
	type BackgroundWorkStatus,
	freshBackgroundWorkStatus,
} from '../shared/background-work-protocol.js'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView } from '../shared/protocol.js'

/** True when a conversation has a running or attention-needing background job worth showing. */
export function hasVisibleBackgroundWork(
	view: ConversationView,
	status: BackgroundWorkStatus | undefined,
): boolean {
	if (view.palId || (view.harness && view.harness !== 'namzu')) return false
	const fresh = freshBackgroundWorkStatus(status)
	return fresh.state === 'known' && (fresh.runningCount > 0 || fresh.needsAttention)
}

/**
 * What a collapsed Pals heading says is inside: the Pals with a "New message" marker, leaving out
 * the one that is open because the person is looking at it. Nothing to say gives `undefined`.
 */
export function palsAttention(
	palIds: readonly string[],
	unreadIds: ReadonlySet<string> | undefined,
	openId?: string,
): string | undefined {
	const count = palIds.filter((id) => unreadIds?.has(id) && id !== openId).length
	if (count === 0) return undefined
	return count === 1 ? '1 Pal has a new message' : `${count} Pals have new messages`
}

/**
 * What a collapsed Projects or Recents heading says is inside: conversations waiting for an
 * answer come first, then ones still working. Nothing to say gives `undefined`.
 */
export function conversationsAttention(
	rows: readonly ConversationView[],
	threads: Readonly<Record<string, ThreadState>>,
	backgroundWork?: Readonly<Record<string, BackgroundWorkStatus>>,
): string | undefined {
	let waiting = 0
	let running = 0
	for (const view of rows) {
		const thread = threads[view.id]
		if (thread?.running && thread.permissions.length > 0) waiting += 1
		else if (thread?.running || hasVisibleBackgroundWork(view, backgroundWork?.[view.id]))
			running += 1
	}
	if (waiting > 0)
		return waiting === 1
			? 'A conversation is waiting for you'
			: `${waiting} conversations are waiting for you`
	if (running > 0)
		return running === 1 ? 'A conversation is running' : `${running} conversations are running`
	return undefined
}

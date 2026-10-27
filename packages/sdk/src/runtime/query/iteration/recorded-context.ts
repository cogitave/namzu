import { NAMZU } from '../../../constants/telemetry/index.js'
import type { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import {
	type Message,
	createTurnContextEntry,
	isTurnContextKey,
	turnContextEntries,
} from '../../../types/message/index.js'
import type { RecordedContextItem } from '../../../types/session/index.js'
import type { Logger } from '../../../utils/logger.js'

/**
 * Append what a step asked to have recorded, after whatever the history
 * ends with.
 *
 * Only at the end: an entry slipped in ahead of the operator's message would
 * put the live array out of log order, and the recorder would then write a
 * whole compaction record to re-base it on every turn. An item adds nothing
 * when its text is empty or equals the last entry under its key, so a step
 * that offers the same text on every call records it once. Returns the
 * entries it added, so a request built before they were added can carry them
 * at the place they will hold.
 */
export function appendRecordedContext(
	recorder: Pick<TurnRecorder, 'messages' | 'pushMessage' | 'turnId'>,
	items: readonly RecordedContextItem[] | undefined,
	log: Pick<Logger, 'warn'>,
	at: Date = new Date(),
): Message[] {
	const appended: Message[] = []
	for (const item of items ?? []) {
		const text = item.text.trim()
		if (text.length === 0) continue
		if (!isTurnContextKey(item.key)) {
			log.warn('A step recorded context under a key that is not a name; it was skipped', {
				[NAMZU.TURN_ID]: recorder.turnId,
				'namzu.runtime.key': String(item.key).slice(0, 80),
			})
			continue
		}
		const earlier = turnContextEntries(recorder.messages, item.key)
		if (earlier.at(-1) === text) continue
		const entry = createTurnContextEntry(item.key, text, at, { later: earlier.length > 0 })
		recorder.pushMessage(entry)
		appended.push(entry)
	}
	return appended
}

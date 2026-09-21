import type { CompactNowInput, CompactionResult } from '../../compaction/manual.js'
import type { SessionId } from '../../types/ids/index.js'
import type { SessionLocatorOptions } from './abandon-turn.js'

/** A compaction a host asks for between turns. */
export interface CompactSessionParams extends Omit<CompactNowInput, 'messages' | 'onShed'> {
	readonly sessionId: SessionId
	/** Where to find the session's log, and the lease to append under. */
	readonly locator?: SessionLocatorOptions
}

/**
 * Compact a session outside any turn. Reads the session's context from its
 * log, compacts it, and appends a `compaction{ trigger: 'manual' }` record
 * with no `turnId`. Refused while a turn is active.
 */
export async function compactSession(_params: CompactSessionParams): Promise<CompactionResult> {
	throw new Error('train: not yet wired')
}

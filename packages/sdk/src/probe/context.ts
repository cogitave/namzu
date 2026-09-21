import type { SessionId, TurnId } from '../types/ids/index.js'
import type { ProbeContext } from '../types/probe/index.js'

export interface ProbeContextInput {
	readonly sessionId?: SessionId
	readonly turnId?: TurnId
	readonly isReplay?: boolean
}

export function buildProbeContext(input: ProbeContextInput = {}): ProbeContext {
	return Object.freeze({
		sessionId: input.sessionId,
		turnId: input.turnId,
		isReplay: input.isReplay ?? false,
	})
}

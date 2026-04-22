import type { RunId } from '../types/ids/index.js'
import type { ProbeContext } from '../types/probe/index.js'

export interface ProbeContextInput {
	readonly runId?: RunId
	readonly isReplay?: boolean
}

export function buildProbeContext(input: ProbeContextInput = {}): ProbeContext {
	return Object.freeze({
		runId: input.runId,
		isReplay: input.isReplay ?? false,
	})
}

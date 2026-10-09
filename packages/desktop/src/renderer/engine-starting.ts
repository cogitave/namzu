import { useEffect, useState } from 'react'
import type { HarnessView } from '../shared/protocol.js'

/** After this long a start is slow enough to deserve a running count. */
export const STARTING_COUNT_AFTER_MS = 1000

/** "Codex CLI" starts as "Codex"; the name the person recognises, without the suffix. */
export function engineStartName(label: string): string {
	return label.replace(/\s+CLI$/i, '')
}

/**
 * What the model trigger reads while an engine process is being started: the plain state first,
 * then the seconds waited once it is no longer instant.
 */
export function startingLabel(label: string, elapsedMs: number): string {
	const name = engineStartName(label)
	return elapsedMs >= STARTING_COUNT_AFTER_MS
		? `Starting ${name}… ${Math.floor(elapsedMs / 1000)}s`
		: `Starting ${name}…`
}

/** An external engine is the only thing whose start is worth naming; Namzu itself is in-process. */
export function startsAProcess(engine: HarnessView['selected'] | undefined): boolean {
	return engine === 'codex-cli' || engine === 'claude-code'
}

/** Milliseconds since `active` last became true; 0 while it is false. Ticks once a second. */
export function useElapsed(active: boolean, now: () => number = Date.now): number {
	const [elapsed, setElapsed] = useState(0)
	useEffect(() => {
		if (!active) {
			setElapsed(0)
			return
		}
		const began = now()
		setElapsed(0)
		const timer = setInterval(() => setElapsed(now() - began), 1000)
		return () => clearInterval(timer)
	}, [active, now])
	return active ? elapsed : 0
}

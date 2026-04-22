import type { RunId } from '../ids/index.js'
import type { ProbeEventKind, VetoableEventKind } from './event-kind.js'
import type { ProbeEventOf } from './event-of.js'

export type Unsubscribe = () => void

export interface ProbeContext {
	readonly runId?: RunId
	readonly isReplay: boolean
}

export type ProbeHandler<K extends ProbeEventKind> = (
	event: ProbeEventOf<K>,
	ctx: ProbeContext,
) => void

export type VetoDecision = 'allow' | 'deny' | { readonly action: 'deny'; readonly reason: string }

export type VetoHandler<K extends VetoableEventKind> = (
	event: ProbeEventOf<K>,
	ctx: ProbeContext,
) => VetoDecision

export interface VetoOutcome {
	readonly action: 'allow' | 'deny'
	readonly probeName?: string
	readonly reason?: string
}

export interface ProbeOptions<K extends ProbeEventKind = ProbeEventKind> {
	readonly where?: (event: ProbeEventOf<K>) => boolean
	readonly priority?: number
	readonly name?: string
	readonly otel?: boolean
	readonly override?: boolean
}

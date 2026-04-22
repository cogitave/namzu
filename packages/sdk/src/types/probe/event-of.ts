import type { ProbeEvent, ProbeEventKind } from './event-kind.js'

export type ProbeEventOf<K extends ProbeEventKind> = Extract<ProbeEvent, { type: K }>

import type { AgentBusEvent } from '../bus/index.js'
import type { SessionEvent } from '../session/events.js'

export type ProbeEventKind = SessionEvent['type'] | AgentBusEvent['type']

export type VetoableEventKind = 'tool_executing'

export type ProbeEvent = SessionEvent | AgentBusEvent

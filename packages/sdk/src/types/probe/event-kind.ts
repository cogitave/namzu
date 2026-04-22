import type { AgentBusEvent } from '../bus/index.js'
import type { RunEvent } from '../run/events.js'

export type ProbeEventKind = RunEvent['type'] | AgentBusEvent['type']

export type VetoableEventKind = 'tool_executing'

export type ProbeEvent = RunEvent | AgentBusEvent

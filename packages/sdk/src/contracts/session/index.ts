// Wire contracts for sessions and turns: snake_case shapes for HTTP, SSE and
// A2A clients. A protocol's "run" is a namzu turn; its thread, context or
// session is a namzu session. The public barrels re-export this module.

export type {
	CreateEphemeralSessionRequest,
	CreateTurnRequest,
	SessionStreamEvent,
	SessionStreamEventType,
	TurnStreamEvent,
	TurnStreamEventData,
	TurnStreamEventType,
} from './api.js'
export { TURN_STREAM_EVENT_TYPES } from './api.js'

export type { TurnStopReason, WireTurn, WireTurnConfig, WireTurnUsage } from './turn.js'

export type { WireTurnStatus } from './turn-status.js'
export { TURN_STATUS_TO_WIRE, WIRE_TURN_STATUSES, toWireTurnStatus } from './turn-status.js'

export {
	CreateEphemeralSessionSchema,
	CreateTurnSchema,
	SessionIdSchema,
	TurnConfigSchema,
	TurnIdSchema,
	TurnStreamEventTypeSchema,
	WireTurnStatusSchema,
} from './schemas.js'

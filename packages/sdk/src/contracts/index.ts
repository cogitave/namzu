// `contracts/` is the package's external wire surface (HTTP/A2A/SSE shapes).
// `types/` is the SDK's internal domain model. Both are re-exported from the
// package barrel, but they serve different audiences:
//   - contracts/* — snake_case wire fields, stable for HTTP and protocol clients.
//   - types/*     — camelCase domain shapes, may include internal-only fields.
// When a wire type is just a rename of a domain type, that's intentional (e.g.
// `TurnStopReason` is the domain stop reason under its wire name).
//
// The session and turn shapes (`WireTurn`, `WireTurnStatus`,
// `CreateTurnRequest`, `CreateEphemeralSessionRequest`, `SessionStreamEvent`
// and their schemas) are defined in `./session/` and re-exported here.

export type {
	ISOTimestamp,
	AgentDefaults,
	AgentInfo,
	ToolCallInfo,
	CreateMessageRequest,
	SessionTreeNode,
	ApiPermissionMode,
	PaginationParams,
	PaginatedResponse,
	ApiErrorType,
	ApiError,
} from './api.js'

export {
	ProjectIdSchema,
	MessageIdSchema,
	CreateMessageSchema,
	PaginationSchema,
	zodErrorToApiError,
} from './schemas.js'

export * from './session/index.js'

export * from './a2a.js'

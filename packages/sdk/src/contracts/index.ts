// `contracts/` is the package's external wire surface (HTTP/A2A/SSE shapes).
// `types/` is the SDK's internal domain model. Both are re-exported from the
// package barrel, but they serve different audiences:
//   - contracts/* — snake_case wire fields, stable for HTTP and protocol clients.
//   - types/*     — camelCase domain shapes, may include internal-only fields.
// When a wire type is just a rename of a domain type, that's intentional (e.g.
// `RunStopReason` aliases `types/run/events.StopReason`).

export type {
	ISOTimestamp,
	AgentDefaults,
	AgentInfo,
	ToolCallInfo,
	CreateMessageRequest,
	WireRunStatus,
	RunStopReason,
	WireRun,
	RunHierarchyNode,
	ApiPermissionMode,
	RunConfig,
	RunUsage,
	CreateRunRequest,
	CreateStatelessRunRequest,
	StreamEventType,
	StreamEvent,
	PaginationParams,
	PaginatedResponse,
	ApiErrorType,
	ApiError,
} from './api.js'

export {
	ProjectIdSchema,
	RunIdSchema,
	MessageIdSchema,
	RunConfigSchema,
	CreateMessageSchema,
	CreateRunSchema,
	CreateStatelessRunSchema,
	PaginationSchema,
	zodErrorToApiError,
} from './schemas.js'

export * from './a2a.js'

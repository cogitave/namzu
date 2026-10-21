// Public SDK surface — split into three focused files by scenario:
//   - public-types.ts    : every type a consumer type-checks against
//   - public-runtime.ts  : every runtime value (classes, functions, consts, schemas)
//   - public-tools.ts    : tool-definition primitive + builtins + builders
//
// ses_011 (2026-04-21): this file is a thin bootstrap. Do not add symbols
// here directly — extend the appropriate bucket file.

export type * from './public-types.js'
export * from './public-runtime.js'
export * from './public-tools.js'

// Work that outlives a tool call, owned by whoever started it. The shell
// cannot be trusted to background under the sandbox's PID namespace, so the
// kernel holds the process itself. See `runtime/jobs/registry.ts`.
export {
	BackgroundJobLimitError,
	BackgroundJobRegistry,
	UnknownBackgroundJobError,
	bindOwner,
	describeMonitorEnd,
} from './runtime/jobs/registry.js'
export {
	MONITOR_BATCH_MAX_CHARS,
	MONITOR_BATCH_WINDOW_MS,
	MONITOR_BUCKET_CAPACITY,
	MONITOR_BUCKET_REFILL_MS,
	MONITOR_LINE_MAX_CHARS,
	MONITOR_NOTIFICATION_MAX_CHARS,
	MONITOR_PARTIAL_LINE_MAX_BYTES,
	MONITOR_SUPPRESSION_LIMIT_MS,
	MONITOR_TIMEOUT_CAP_MS,
	MONITOR_TIMEOUT_DEFAULT_MS,
	MONITOR_TIMEOUT_MAX_MS,
	MONITOR_TIMEOUT_MIN_MS,
	createMonitorStream,
	formatMonitorDuration,
} from './runtime/jobs/monitor-stream.js'
export type {
	MonitorStream,
	MonitorStreamOptions,
	MonitorStreamStats,
} from './runtime/jobs/monitor-stream.js'
export {
	createBackgroundJobId,
	isBackgroundJobId,
} from './runtime/jobs/job-id.js'
export type {
	BackgroundJob,
	BackgroundJobOutput,
	BackgroundJobRegistryConfig,
	BackgroundJobStatus,
	MonitorEvent,
	StartJobParams,
} from './runtime/jobs/registry.js'

export {
	TelemetryProvider,
	registerTelemetry,
	getTelemetry,
	getTracer,
	getMeter,
} from './provider.js'

export { createPlatformMetrics } from './metrics.js'
export type { PlatformMetrics } from './metrics.js'

/**
 * `SpanProcessorLike` is here because `TelemetryConfig.spanProcessors` takes
 * an array of it. Without the export a host could supply the value and had no
 * way to NAME its type — a field on the public surface whose type was not on
 * it, so every consumer had to inline the shape or reach for `any`.
 */
export type { TelemetryConfig, ExporterType, SpanProcessorLike } from './types.js'

export {
	CONTENT_BEARING_EVENT_TYPES,
	createSessionExportListener,
	describeSessionExport,
	secretRedactor,
} from './session-export.js'
export type {
	SessionExportConfig,
	SessionExportListener,
	SessionExportRecord,
	SessionExportRedactor,
	SessionExportSink,
} from './session-export.js'

export {
	TelemetryProvider,
	registerTelemetry,
	getTelemetry,
	getTracer,
	getMeter,
} from './provider.js'

export { createPlatformMetrics } from './metrics.js'
export type { PlatformMetrics } from './metrics.js'

export type { TelemetryConfig, ExporterType } from './types.js'

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

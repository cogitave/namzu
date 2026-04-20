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

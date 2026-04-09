export {
	TelemetryProvider,
	initTelemetry,
	getTelemetry,
	getTracer,
	getMeter,
} from '../provider/telemetry/setup.js'

export type { TelemetryConfig, ExporterType } from '../types/telemetry/index.js'

export { createPlatformMetrics } from './metrics.js'
export type { PlatformMetrics } from './metrics.js'

export * from './attributes.js'

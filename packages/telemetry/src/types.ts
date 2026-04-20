export type ExporterType = 'console' | 'otlp' | 'none'

export interface TelemetryConfig {
	serviceName: string
	serviceVersion?: string
	exporterType: ExporterType
	otlpEndpoint?: string
	otlpHeaders?: Record<string, string>
	metricExportIntervalMs?: number
}

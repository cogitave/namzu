export type ExporterType = 'console' | 'otlp' | 'none'

export interface TelemetryConfig {
	serviceName: string
	serviceVersion?: string
	exporterType: ExporterType
	otlpEndpoint?: string
	otlpHeaders?: Record<string, string>
	metricExportIntervalMs?: number
	/**
	 * Extra span processors, installed alongside whatever `exporterType`
	 * selects.
	 *
	 * The tracing SDK used to let a host attach a processor to an already
	 * registered provider; it now takes them only at construction, so a
	 * host that wants its own export path — a test collector, a second
	 * destination, a redaction stage — has to hand them over here or has
	 * no way in at all.
	 *
	 * Typed structurally so this package does not force its own copy of the
	 * tracing SDK on a consumer that already has one.
	 */
	spanProcessors?: readonly SpanProcessorLike[]
}

/** The processor contract, read structurally to avoid a version pin. */
export interface SpanProcessorLike {
	onStart(...args: never[]): void
	onEnd(...args: never[]): void
	forceFlush(): Promise<void>
	shutdown(): Promise<void>
}

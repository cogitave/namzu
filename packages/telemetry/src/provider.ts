import { type Meter, type Tracer, metrics, trace } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Resource } from '@opentelemetry/resources'
import {
	ConsoleMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import {
	ConsoleSpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import type { TelemetryConfig } from './types.js'
import { VERSION } from './version.js'

function toErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message
	if (typeof err === 'string') return err
	try {
		return JSON.stringify(err)
	} catch {
		return String(err)
	}
}

export class TelemetryProvider {
	private tracerProvider: NodeTracerProvider | null = null
	private meterProvider: MeterProvider | null = null
	private config: TelemetryConfig
	private _tracer: Tracer | null = null
	private _meter: Meter | null = null

	constructor(config: TelemetryConfig) {
		this.config = config
	}

	get tracer(): Tracer {
		if (!this._tracer) {
			this._tracer = trace.getTracer(this.config.serviceName, this.config.serviceVersion ?? VERSION)
		}
		return this._tracer
	}

	get meter(): Meter {
		if (!this._meter) {
			this._meter = metrics.getMeter(this.config.serviceName, this.config.serviceVersion ?? VERSION)
		}
		return this._meter
	}

	/**
	 * Install a real TracerProvider and MeterProvider on @opentelemetry/api
	 * globals. ALWAYS installs — even when exporterType is 'none' — so the
	 * api surface stays live (spans get valid contexts, meters accept
	 * writes). The exporterType switch only controls whether anything is
	 * actually EMITTED downstream: 'none' means no span processor and no
	 * metric reader, so spans created through the real provider are
	 * discarded at end() without touching any exporter.
	 *
	 * This matches the docs' stated semantics: "Disable exporter startup
	 * while keeping the API surface available." (docs/sdk/observability
	 * /README.md §4).
	 */
	async start(): Promise<void> {
		const resource = new Resource({
			'service.name': this.config.serviceName,
			'service.version': this.config.serviceVersion ?? VERSION,
		})

		const tracerProvider = new NodeTracerProvider({ resource })
		if (this.config.exporterType !== 'none') {
			const traceExporter =
				this.config.exporterType === 'otlp'
					? new OTLPTraceExporter({
							url: this.config.otlpEndpoint ? `${this.config.otlpEndpoint}/v1/traces` : undefined,
							headers: this.config.otlpHeaders,
						})
					: new ConsoleSpanExporter()
			tracerProvider.addSpanProcessor(new SimpleSpanProcessor(traceExporter))
		}
		tracerProvider.register()
		this.tracerProvider = tracerProvider

		const metricReaders: PeriodicExportingMetricReader[] = []
		if (this.config.exporterType !== 'none') {
			const metricExporter =
				this.config.exporterType === 'otlp'
					? new OTLPMetricExporter({
							url: this.config.otlpEndpoint ? `${this.config.otlpEndpoint}/v1/metrics` : undefined,
							headers: this.config.otlpHeaders,
						})
					: new ConsoleMetricExporter()
			metricReaders.push(
				new PeriodicExportingMetricReader({
					exporter: metricExporter,
					exportIntervalMillis: this.config.metricExportIntervalMs ?? 10_000,
				}),
			)
		}
		this.meterProvider = new MeterProvider({ resource, readers: metricReaders })
		metrics.setGlobalMeterProvider(this.meterProvider)
	}

	async shutdown(): Promise<void> {
		try {
			if (this.meterProvider) {
				await this.meterProvider.shutdown()
			}
			if (this.tracerProvider) {
				await this.tracerProvider.shutdown()
			}
		} catch (err) {
			// biome-ignore lint/suspicious/noConsole: shutdown is the error-of-last-resort path; no app logger available here
			console.error('[@namzu/telemetry] Telemetry shutdown error:', toErrorMessage(err))
		}
	}
}

let _globalProvider: TelemetryProvider | null = null

/**
 * Install a TelemetryProvider as the process-global trace + meter provider.
 *
 * Mutates `@opentelemetry/api`'s global TracerProvider and MeterProvider —
 * always, regardless of `exporterType`. OTEL-idiomatic library/application
 * pattern; not dependency injection.
 *
 * MUST be awaited: `start()` returns `Promise<void>` and configures the
 * trace + metric pipelines asynchronously. Firing-and-forgetting would
 * detach startup failures into an unhandled rejection and hide
 * misconfigurations.
 *
 * Call once at process startup, before any code creates spans or acquires
 * meters. Without it, `@opentelemetry/api`'s no-op defaults silently
 * discard spans and metric writes.
 */
export async function registerTelemetry(config: TelemetryConfig): Promise<TelemetryProvider> {
	const provider = new TelemetryProvider(config)
	_globalProvider = provider
	await provider.start()
	return provider
}

export function getTelemetry(): TelemetryProvider | null {
	return _globalProvider
}

export function getTracer(): Tracer {
	return _globalProvider?.tracer ?? trace.getTracer('namzu')
}

export function getMeter(): Meter {
	return _globalProvider?.meter ?? metrics.getMeter('namzu')
}

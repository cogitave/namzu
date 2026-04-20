import { type Meter, type Tracer, metrics, trace } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Resource } from '@opentelemetry/resources'
import {
	ConsoleMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import type { TelemetryConfig } from './types.js'

const PACKAGE_VERSION = '0.0.0'

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
	private sdk: NodeSDK | null = null
	private meterProvider: MeterProvider | null = null
	private config: TelemetryConfig
	private _tracer: Tracer | null = null
	private _meter: Meter | null = null

	constructor(config: TelemetryConfig) {
		this.config = config
	}

	get tracer(): Tracer {
		if (!this._tracer) {
			this._tracer = trace.getTracer(
				this.config.serviceName,
				this.config.serviceVersion ?? PACKAGE_VERSION,
			)
		}
		return this._tracer
	}

	get meter(): Meter {
		if (!this._meter) {
			this._meter = metrics.getMeter(
				this.config.serviceName,
				this.config.serviceVersion ?? PACKAGE_VERSION,
			)
		}
		return this._meter
	}

	async start(): Promise<void> {
		if (this.config.exporterType === 'none') {
			return
		}

		const resource = new Resource({
			'service.name': this.config.serviceName,
			'service.version': this.config.serviceVersion ?? PACKAGE_VERSION,
		})

		const traceExporter =
			this.config.exporterType === 'otlp'
				? new OTLPTraceExporter({
						url: this.config.otlpEndpoint ? `${this.config.otlpEndpoint}/v1/traces` : undefined,
						headers: this.config.otlpHeaders,
					})
				: new ConsoleSpanExporter()

		const metricExporter =
			this.config.exporterType === 'otlp'
				? new OTLPMetricExporter({
						url: this.config.otlpEndpoint ? `${this.config.otlpEndpoint}/v1/metrics` : undefined,
						headers: this.config.otlpHeaders,
					})
				: new ConsoleMetricExporter()

		this.meterProvider = new MeterProvider({
			resource,
			readers: [
				new PeriodicExportingMetricReader({
					exporter: metricExporter,
					exportIntervalMillis: this.config.metricExportIntervalMs ?? 10_000,
				}),
			],
		})
		metrics.setGlobalMeterProvider(this.meterProvider)

		this.sdk = new NodeSDK({
			resource,
			spanProcessor: new SimpleSpanProcessor(traceExporter),
		})

		this.sdk.start()
	}

	async shutdown(): Promise<void> {
		try {
			if (this.meterProvider) {
				await this.meterProvider.shutdown()
			}
			if (this.sdk) {
				await this.sdk.shutdown()
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
 * Mutates `@opentelemetry/api`'s global TracerProvider and MeterProvider via
 * `NodeSDK.start()` (which calls `trace.setGlobalTracerProvider`) and an
 * explicit `metrics.setGlobalMeterProvider(...)` call inside
 * `TelemetryProvider.start()`. This is the OTEL library/application pattern
 * documented by the OpenTelemetry project. It is not dependency injection.
 *
 * MUST be awaited: `start()` returns `Promise<void>` and attaches the OTEL
 * Node SDK asynchronously. Firing-and-forgetting would detach startup
 * failures into an unhandled rejection and hide misconfigurations.
 *
 * Call once at process startup, before any code creates spans or acquires
 * meters. Without it, `@opentelemetry/api`'s no-op defaults silently discard
 * spans and metric writes.
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

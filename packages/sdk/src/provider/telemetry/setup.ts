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
import type { TelemetryConfig } from '../../types/telemetry/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { getRootLogger } from '../../utils/logger.js'
import { VERSION } from '../../version.js'

const logger = getRootLogger().child({ component: 'TelemetryProvider' })

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

	async start(): Promise<void> {
		if (this.config.exporterType === 'none') {
			logger.info('Telemetry disabled (exporterType=none)')
			return
		}

		const resource = new Resource({
			'service.name': this.config.serviceName,
			'service.version': this.config.serviceVersion ?? VERSION,
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
		logger.info(`Telemetry started (exporter=${this.config.exporterType})`)
	}

	async shutdown(): Promise<void> {
		try {
			if (this.meterProvider) {
				await this.meterProvider.shutdown()
			}
			if (this.sdk) {
				await this.sdk.shutdown()
			}
			logger.info('Telemetry shutdown complete')
		} catch (err) {
			logger.error('Telemetry shutdown error', {
				error: toErrorMessage(err),
			})
		}
	}
}

let _globalProvider: TelemetryProvider | null = null

export function initTelemetry(config: TelemetryConfig): TelemetryProvider {
	_globalProvider = new TelemetryProvider(config)
	return _globalProvider
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

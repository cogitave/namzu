import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
	traceOtlp: vi.fn(),
	metricOtlp: vi.fn(),
	traceConsole: vi.fn(),
	metricConsole: vi.fn(),
	tracer: vi.fn(),
	meter: vi.fn(),
	traceShutdown: vi.fn(async () => {}),
	metricShutdown: vi.fn(async () => {}),
}))

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
	OTLPTraceExporter: class {
		constructor(options: unknown) {
			fakes.traceOtlp(options)
		}
	},
}))
vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
	OTLPMetricExporter: class {
		constructor(options: unknown) {
			fakes.metricOtlp(options)
		}
	},
}))
vi.mock('@opentelemetry/sdk-trace-node', () => ({
	ConsoleSpanExporter: class {
		constructor() {
			fakes.traceConsole()
		}
	},
	BatchSpanProcessor: class {},
	NodeTracerProvider: class {
		constructor(options: unknown) {
			fakes.tracer(options)
		}
		register() {}
		shutdown = fakes.traceShutdown
	},
}))
vi.mock('@opentelemetry/sdk-metrics', () => ({
	ConsoleMetricExporter: class {
		constructor() {
			fakes.metricConsole()
		}
	},
	PeriodicExportingMetricReader: class {},
	MeterProvider: class {
		constructor(options: unknown) {
			fakes.meter(options)
		}
		shutdown = fakes.metricShutdown
	},
}))
vi.mock('@opentelemetry/resources', () => ({
	resourceFromAttributes: (attributes: unknown) => attributes,
}))
vi.mock('@opentelemetry/api', () => ({
	trace: { getTracer: vi.fn() },
	metrics: { getMeter: vi.fn(), setGlobalMeterProvider: vi.fn() },
}))

import { TelemetryProvider } from '../provider.js'
import type { ExporterType } from '../types.js'

beforeEach(() => {
	vi.clearAllMocks()
	fakes.metricShutdown.mockResolvedValue(undefined)
	fakes.traceShutdown.mockResolvedValue(undefined)
})

const exporters: ExporterType[] = ['none', 'console', 'otlp']

describe('independent exporter pipelines (no real exporters)', () => {
	for (const traces of exporters) {
		for (const metrics of exporters) {
			it(`${traces} traces and ${metrics} metrics construct only their chosen exporters`, async () => {
				const provider = new TelemetryProvider({
					serviceName: 'test',
					exporterType: 'none',
					traceExporterType: traces,
					metricExporterType: metrics,
					otlpEndpoint: 'http://collector:4318',
					otlpHeaders: { authorization: 'secret' },
				})
				await provider.start()
				expect(fakes.traceOtlp).toHaveBeenCalledTimes(traces === 'otlp' ? 1 : 0)
				expect(fakes.traceConsole).toHaveBeenCalledTimes(traces === 'console' ? 1 : 0)
				expect(fakes.metricOtlp).toHaveBeenCalledTimes(metrics === 'otlp' ? 1 : 0)
				expect(fakes.metricConsole).toHaveBeenCalledTimes(metrics === 'console' ? 1 : 0)
				if (traces === 'otlp') {
					expect(fakes.traceOtlp).toHaveBeenCalledWith({
						url: 'http://collector:4318/v1/traces',
						headers: { authorization: 'secret' },
					})
				}
				if (metrics === 'otlp') {
					expect(fakes.metricOtlp).toHaveBeenCalledWith({
						url: 'http://collector:4318/v1/metrics',
						headers: { authorization: 'secret' },
					})
				}
				await provider.shutdown()
				expect(fakes.traceShutdown).toHaveBeenCalledTimes(1)
				expect(fakes.metricShutdown).toHaveBeenCalledTimes(1)
			})
		}
	}

	it('keeps the legacy exporterType fallback when no overrides are supplied', async () => {
		await new TelemetryProvider({ serviceName: 'test', exporterType: 'console' }).start()
		expect(fakes.traceConsole).toHaveBeenCalledTimes(1)
		expect(fakes.metricConsole).toHaveBeenCalledTimes(1)
	})

	it('rejects an unsupported active protocol before constructing either pipeline', async () => {
		const provider = new TelemetryProvider({
			serviceName: 'test',
			exporterType: 'otlp',
			otlpProtocol: 'grpc' as never,
		})
		await expect(provider.start()).rejects.toThrow('Unsupported OTLP traces protocol')
		expect(fakes.tracer).not.toHaveBeenCalled()
		expect(fakes.meter).not.toHaveBeenCalled()
		expect(fakes.traceOtlp).not.toHaveBeenCalled()
		expect(fakes.metricOtlp).not.toHaveBeenCalled()
	})

	it('drains traces even when metric shutdown fails', async () => {
		const provider = new TelemetryProvider({ serviceName: 'test', exporterType: 'none' })
		await provider.start()
		fakes.metricShutdown.mockRejectedValueOnce(new Error('metrics failed'))
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			await provider.shutdown()
			expect(fakes.traceShutdown).toHaveBeenCalledTimes(1)
			expect(stderr).toHaveBeenCalledWith(expect.any(String), 'metrics failed')
		} finally {
			stderr.mockRestore()
		}
	})
})

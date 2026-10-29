import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	parseOtlpHeaders,
	resetOtlpExportForTests,
	resolveOtlpExport,
	startOtlpExport,
} from '../otlp-export.js'

describe('asking for the export', () => {
	it('is off with nothing set', () => {
		expect(resolveOtlpExport(undefined, {})).toBeUndefined()
		// A collector address alone is not a request.
		expect(
			resolveOtlpExport(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }),
		).toBeUndefined()
	})

	it('turns on with the switch and reads the standard variables', () => {
		expect(
			resolveOtlpExport(undefined, {
				NAMZU_ENABLE_TELEMETRY: '1',
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318/',
				OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20abc, x-team=core',
			}),
		).toEqual({
			traceExporterType: 'otlp',
			metricExporterType: 'otlp',
			traceOtlpProtocol: 'http/json',
			metricOtlpProtocol: 'http/json',
			endpoint: 'http://c:4318',
			headers: { authorization: 'Bearer abc', 'x-team': 'core' },
		})
	})

	it('lets the config file win over the environment', () => {
		const r = resolveOtlpExport(
			{ endpoint: 'http://file:4318', headers: { a: '1' } },
			{ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env:4318', OTEL_EXPORTER_OTLP_HEADERS: 'a=0,b=2' },
		)
		expect(r).toEqual({
			traceExporterType: 'otlp',
			metricExporterType: 'otlp',
			traceOtlpProtocol: 'http/json',
			metricOtlpProtocol: 'http/json',
			endpoint: 'http://file:4318',
			headers: { a: '1', b: '2' },
		})
	})

	it('prints to the terminal for console and stays off for none', () => {
		expect(resolveOtlpExport({}, { OTEL_TRACES_EXPORTER: 'console' })?.traceExporterType).toBe(
			'console',
		)
		expect(
			resolveOtlpExport({}, { OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' }),
		).toBeUndefined()
	})

	it.each(['TRACES', 'METRICS'] as const)('disables only %s when it is none', (signal) => {
		const result = resolveOtlpExport({}, { [`OTEL_${signal}_EXPORTER`]: 'none' })
		expect(result?.traceExporterType).toBe(signal === 'TRACES' ? 'none' : 'otlp')
		expect(result?.metricExporterType).toBe(signal === 'METRICS' ? 'none' : 'otlp')
	})

	it('keeps console traces and OTLP metrics independent', () => {
		expect(resolveOtlpExport({}, { OTEL_TRACES_EXPORTER: 'console' })).toMatchObject({
			traceExporterType: 'console',
			metricExporterType: 'otlp',
			metricOtlpProtocol: 'http/json',
		})
	})

	it('signal protocols override the general protocol only for an OTLP signal', () => {
		expect(
			resolveOtlpExport(
				{},
				{
					OTEL_TRACES_EXPORTER: 'none',
					OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
					OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
				},
			),
		).toMatchObject({ traceExporterType: 'none', metricOtlpProtocol: 'http/json' })
		expect(() => resolveOtlpExport({}, { OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toThrow(
			'Unsupported OTLP traces protocol',
		)
	})

	it('skips malformed header pairs', () => {
		expect(parseOtlpHeaders('novalue,=x,ok=1,bad=%E0%A4%A')).toEqual({ ok: '1', bad: '%E0%A4%A' })
	})
})

describe('starting it', () => {
	beforeEach(() => resetOtlpExportForTests())

	it('registers once with the resolved destination and drains on shutdown', async () => {
		const shutdown = vi.fn(async () => {})
		const registerTelemetry = vi.fn(async () => ({ shutdown }))
		const options = {
			config: { endpoint: 'http://c:4318' },
			env: {},
			serviceVersion: '9.9.9',
			loader: async () => ({ registerTelemetry }),
			warn: vi.fn(),
		}
		const a = await startOtlpExport(options)
		const b = await startOtlpExport(options)
		expect(b).toBe(a)
		expect(registerTelemetry).toHaveBeenCalledTimes(1)
		expect(registerTelemetry).toHaveBeenCalledWith({
			serviceName: 'namzu',
			serviceVersion: '9.9.9',
			exporterType: 'none',
			traceExporterType: 'otlp',
			metricExporterType: 'otlp',
			traceOtlpProtocol: 'http/json',
			metricOtlpProtocol: 'http/json',
			otlpEndpoint: 'http://c:4318',
		})
		await a?.shutdown()
		expect(shutdown).toHaveBeenCalledTimes(1)
	})

	it('does not load exporters for both none or an unsupported active protocol', async () => {
		const loader = vi.fn()
		const warn = vi.fn()
		expect(
			await startOtlpExport({
				config: {},
				env: { OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' },
				loader,
				warn,
			}),
		).toBeUndefined()
		expect(loader).not.toHaveBeenCalled()
		resetOtlpExportForTests()
		expect(
			await startOtlpExport({
				config: {},
				env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf' },
				loader,
				warn,
			}),
		).toBeUndefined()
		expect(loader).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unsupported OTLP traces protocol'))
	})

	it('does not load anything when not asked', async () => {
		const loader = vi.fn()
		expect(
			await startOtlpExport({ config: undefined, env: {}, loader, warn: vi.fn() }),
		).toBeUndefined()
		expect(loader).not.toHaveBeenCalled()
	})

	it('warns and carries on when the package cannot load', async () => {
		const warn = vi.fn()
		const r = await startOtlpExport({
			config: {},
			env: {},
			loader: async () => {
				throw new Error('not installed')
			},
			warn,
		})
		expect(r).toBeUndefined()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('Continuing without it'))
	})
})

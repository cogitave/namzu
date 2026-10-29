import type { OtlpExportConfig } from '../../config/schema.js'
import { loadTelemetryFrom } from './session-export.js'

/**
 * Sending the kernel's spans and metrics to an OpenTelemetry collector.
 *
 * Off unless asked for. What goes out is what the kernel already puts on its
 * spans and metrics: timings, counts and names, plus the conversation id and
 * the error text of a failed tool call (which can hold a command line or a
 * path). No prompt or reply is attached. Two
 * ways to ask, so a shell profile and a project file both work:
 *
 * - `NAMZU_ENABLE_TELEMETRY=1`, with the standard `OTEL_EXPORTER_OTLP_ENDPOINT`
 *   and `OTEL_EXPORTER_OTLP_HEADERS` choosing where it goes.
 * - `telemetry.otlp` in a config file, whose `endpoint` and `headers` win
 *   over the environment.
 *
 * Each signal independently selects none, console or OTLP. This package ships
 * HTTP/JSON; an explicitly unsupported OTLP protocol is reported, never silently
 * substituted with another transport.
 *
 * Unlike session export, a missing `@namzu/telemetry` does not stop the run:
 * nothing the operator is counting on for a record is lost, so it is a
 * warning.
 */

export interface ResolvedOtlpExport {
	readonly traceExporterType: 'otlp' | 'console' | 'none'
	readonly metricExporterType: 'otlp' | 'console' | 'none'
	readonly traceOtlpProtocol?: 'http/json'
	readonly metricOtlpProtocol?: 'http/json'
	readonly endpoint?: string
	readonly headers?: Readonly<Record<string, string>>
}

const TRUE = new Set(['1', 'true', 'yes', 'on'])

/** `k=v,k2=v2`, values percent-decoded, as the OpenTelemetry environment defines. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
	const out: Record<string, string> = {}
	if (!raw) return out
	for (const part of raw.split(',')) {
		const at = part.indexOf('=')
		if (at <= 0) continue
		const key = part.slice(0, at).trim()
		if (key === '') continue
		const value = part.slice(at + 1).trim()
		try {
			out[key] = decodeURIComponent(value)
		} catch {
			out[key] = value
		}
	}
	return out
}

export function resolveOtlpExport(
	config: OtlpExportConfig | undefined,
	env: Readonly<Record<string, string | undefined>>,
): ResolvedOtlpExport | undefined {
	const enabled = config !== undefined || TRUE.has((env.NAMZU_ENABLE_TELEMETRY ?? '').toLowerCase())
	if (!enabled) return undefined
	const exporter = (raw: string | undefined, signal: string) => {
		const value = raw?.trim().toLowerCase() || 'otlp'
		if (value === 'none' || value === 'console' || value === 'otlp') return value
		throw new Error(`Unsupported ${signal} exporter: ${raw}; use none, console or otlp.`)
	}
	const traces = exporter(env.OTEL_TRACES_EXPORTER, 'traces')
	const metrics = exporter(env.OTEL_METRICS_EXPORTER, 'metrics')
	if (traces === 'none' && metrics === 'none') return undefined
	const protocol = (signal: 'TRACES' | 'METRICS'): 'http/json' => {
		const value = (
			env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`] ??
			env.OTEL_EXPORTER_OTLP_PROTOCOL ??
			'http/json'
		)
			.trim()
			.toLowerCase()
		if (value !== 'http/json') {
			throw new Error(`Unsupported OTLP ${signal.toLowerCase()} protocol: ${value}; use http/json.`)
		}
		return value
	}
	const raw = config?.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT
	// The package appends the signal path itself.
	const endpoint = raw ? raw.replace(/\/+$/, '') : undefined
	const headers = {
		...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
		...(config?.headers ?? {}),
	}
	return {
		traceExporterType: traces,
		metricExporterType: metrics,
		...(traces === 'otlp' ? { traceOtlpProtocol: protocol('TRACES') } : {}),
		...(metrics === 'otlp' ? { metricOtlpProtocol: protocol('METRICS') } : {}),
		...(endpoint ? { endpoint } : {}),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
	}
}

interface TelemetryRegistrar {
	registerTelemetry(config: {
		serviceName: string
		serviceVersion?: string
		exporterType: 'otlp' | 'console' | 'none'
		traceExporterType: 'otlp' | 'console' | 'none'
		metricExporterType: 'otlp' | 'console' | 'none'
		traceOtlpProtocol?: 'http/json'
		metricOtlpProtocol?: 'http/json'
		otlpEndpoint?: string
		otlpHeaders?: Record<string, string>
	}): Promise<{ shutdown(): Promise<void> }>
}

export interface StartedOtlpExport {
	/** Send what is still queued; call before the process exits. */
	shutdown(): Promise<void>
}

export interface StartOtlpExportOptions {
	readonly config: OtlpExportConfig | undefined
	readonly env: Readonly<Record<string, string | undefined>>
	readonly serviceVersion?: string
	/** Injectable for tests; production loads the installed package. */
	readonly loader?: () => Promise<TelemetryRegistrar>
	readonly warn: (message: string) => void
}

let started: Promise<StartedOtlpExport | undefined> | undefined

/** Idempotent: the first call decides, later calls return the same handle. */
export function startOtlpExport(
	options: StartOtlpExportOptions,
): Promise<StartedOtlpExport | undefined> {
	if (started) return started
	started = (async () => {
		try {
			const resolved = resolveOtlpExport(options.config, options.env)
			if (!resolved) return undefined
			const mod = options.loader
				? await options.loader()
				: ((await loadTelemetryFrom('@namzu/telemetry')) as unknown as TelemetryRegistrar)
			const provider = await mod.registerTelemetry({
				serviceName: 'namzu',
				...(options.serviceVersion ? { serviceVersion: options.serviceVersion } : {}),
				// Legacy fallback off; each signal explicitly opts into its exporter.
				exporterType: 'none',
				traceExporterType: resolved.traceExporterType,
				metricExporterType: resolved.metricExporterType,
				...(resolved.traceOtlpProtocol ? { traceOtlpProtocol: resolved.traceOtlpProtocol } : {}),
				...(resolved.metricOtlpProtocol ? { metricOtlpProtocol: resolved.metricOtlpProtocol } : {}),
				...(resolved.endpoint ? { otlpEndpoint: resolved.endpoint } : {}),
				...(resolved.headers ? { otlpHeaders: { ...resolved.headers } } : {}),
			})
			return { shutdown: () => provider.shutdown() }
		} catch (error) {
			options.warn(
				`Telemetry export was asked for but could not start (${error instanceof Error ? error.message : String(error)}). Continuing without it.`,
			)
			return undefined
		}
	})()
	return started
}

/** Test seam: forget the first call's decision. */
export function resetOtlpExportForTests(): void {
	started = undefined
}

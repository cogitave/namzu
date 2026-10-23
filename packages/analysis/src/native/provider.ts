import type {
	NativeAnalysisProvider,
	NativeImportsParams,
	NativeStringsParams,
	NativeSymbolsParams,
	NativeTargetParams,
} from '@namzu/sdk'

import { createNativeAnalysis, type NativeAnalysis, type NativeAnalysisOptions } from './client.js'
import { NativeAnalysisError } from './errors.js'

/** What a host may tune; the sidecar's own defaults hold otherwise. */
export interface NativeAnalysisProviderOptions {
	/** Explicit sidecar path; see `resolveSidecar` for the full order. */
	binaryPath?: string
	/** Wall-clock limit for one request, in milliseconds (default 60 000). */
	deadlineMs?: number
	/** Largest result a request may produce, in bytes (default 4 MiB). */
	maxOutputBytes?: number
	/** Receives each line the sidecar writes to stderr. */
	onDiagnostic?: (line: string) => void
}

/**
 * The SDK seam over the sidecar client.
 *
 * `createNativeAnalysis` spawns nothing until the first request, so a host can
 * hold one of these on every session that might ask a binary question and pay
 * nothing unless it does. No sidecar is found until then either: the machine
 * answers `sidecar_not_found` on the first call rather than at construction,
 * so a session on an install without the binary still starts.
 */
export function createNativeAnalysisProvider(
	options: NativeAnalysisProviderOptions = {},
): NativeAnalysisProvider {
	let sidecar: NativeAnalysis | undefined
	const settings: NativeAnalysisOptions = {
		...(options.binaryPath !== undefined ? { binaryPath: options.binaryPath } : {}),
		...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
		...(options.maxOutputBytes !== undefined
			? { maxOutputBytes: options.maxOutputBytes }
			: {}),
		...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
	}
	const load = (): NativeAnalysis => {
		sidecar ??= createNativeAnalysis(settings)
		return sidecar
	}
	// A construction failure (typically `sidecar_not_found`) is an answer the
	// tool turns into a failure line, not a reason the seam cannot be held.
	const call = <T>(run: (sidecar: NativeAnalysis) => Promise<T>): Promise<T> => {
		let client: NativeAnalysis
		try {
			client = load()
		} catch (err) {
			return Promise.reject(
				err instanceof NativeAnalysisError
					? err
					: new NativeAnalysisError('sidecar_not_found', err instanceof Error ? err.message : String(err)),
			)
		}
		return run(client)
	}
	return {
		binaryInfo: (params: NativeTargetParams) => call((s) => s.binaryInfo(params)),
		symbols: (params: NativeSymbolsParams) => call((s) => s.symbols(params)),
		imports: (params: NativeImportsParams) => call((s) => s.imports(params)),
		exports: (params: NativeImportsParams) => call((s) => s.exports(params)),
		strings: (params: NativeStringsParams) => call((s) => s.strings(params)),
		async dispose() {
			// Never loaded means nothing is running; spawning the sidecar just to
			// close it would cost exactly what the laziness saved.
			const pending = sidecar
			sidecar = undefined
			await pending?.close().catch(() => undefined)
		},
	}
}

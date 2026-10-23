import { createNativeAnalysis, createNativeAnalysisProvider } from '@namzu/analysis'
import type { NativeAnalysisProvider } from '@namzu/sdk'

/**
 * The native binary reader, constructed on first use — but the laziness is
 * already one level down: `createNativeAnalysisProvider` spawns nothing and
 * looks for no binary until the model's first `binary_analysis` call. This
 * exists so the session holds a provider without importing the package at
 * startup, exactly what `@namzu/analysis`'s lazy adapter gives.
 */
export function createLazyNativeAnalysis(): NativeAnalysisProvider {
	return createNativeAnalysisProvider({})
}

/** Where a finder should look, for `namzu doctor`-style reporting. */
export const NATIVE_ANALYSIS_ENV = 'NAMZU_ANALYSIS_NATIVE_BIN'

/**
 * What `namzu doctor` runs: spawn the real sidecar (the same one a
 * `binary_analysis` call would start) and ask it who it is. A missing Rust
 * toolchain or binary is `warn`, never an error: the tool is optional, and
 * `read`/`grep` carry turns without it.
 */
export async function nativeAnalysisSelfTest(): Promise<
	{ ok: true; detail: string } | { ok: false; detail: string }
> {
	try {
		const sidecar = createNativeAnalysis()
		try {
			const hello = await sidecar.hello({ deadlineMs: 10_000 })
			if (hello.name !== 'namzu-analysis-native') {
				return {
					ok: false,
					detail: `the sidecar answered, but calls itself ${hello.name}`,
				}
			}
			return {
				ok: true,
				detail: `sidecar v${hello.version} answered hello (protocol ${hello.protocol})`,
			}
		} finally {
			await sidecar.close().catch(() => undefined)
		}
	} catch (error) {
		return {
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		}
	}
}

import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { nativeAnalysisSelfTest } from '../../integrations/analysis/native-analysis.js'

/**
 * Whether the native binary analysis sidecar starts and speaks here. A
 * failure is `warn`: the tool is optional — a checkout without a Rust
 * toolchain builds everything else fine, and `read` covers the text paths.
 */
export async function describeNativeAnalysis(): Promise<DoctorCheckResult> {
	const result = await nativeAnalysisSelfTest()
	if (result.ok)
		return {
			status: 'pass',
			message: `native binary analysis works; ${result.detail}`,
		}
	return {
		status: 'warn',
		message: `native binary analysis unavailable: ${result.detail}`,
		remediation:
			'Run `pnpm --filter @namzu/analysis build` in a checkout (binaryPath or NAMZU_ANALYSIS_NATIVE_BIN names it for a packaged CLI). Until then binary_analysis answers that it is unavailable.',
	}
}

export const nativeAnalysisCheck: DoctorCheck = {
	id: 'analysisNative.hello',
	category: 'custom',
	run: (): Promise<DoctorCheckResult> => describeNativeAnalysis(),
}

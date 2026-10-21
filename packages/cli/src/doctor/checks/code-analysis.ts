import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { codeAnalysisSelfTest } from '../../integrations/analysis/provider.js'

/**
 * Whether the code index works on this install: its parser loads, its parsing
 * child starts, and a one-file index answers. A failure is `warn`: the tool is
 * optional, the model falls back to `grep`, and namzu runs without it.
 */
export async function describeCodeAnalysis(): Promise<DoctorCheckResult> {
	const result = await codeAnalysisSelfTest()
	if (result.ok) return { status: 'pass', message: `code index works; ${result.detail}` }
	return {
		status: 'warn',
		message: `code index unavailable: ${result.detail}`,
		remediation:
			'Reinstall @namzu/cli. Until then code_analysis answers that it is unavailable and grep is used.',
	}
}

export const codeAnalysisCheck: DoctorCheck = {
	id: 'codeAnalysis.index',
	category: 'custom',
	run: (): Promise<DoctorCheckResult> => describeCodeAnalysis(),
}

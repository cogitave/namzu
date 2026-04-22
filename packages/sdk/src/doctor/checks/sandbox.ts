import { constants, access } from 'node:fs/promises'

import type { DoctorCheck, DoctorCheckResult } from '../../types/doctor/index.js'

const DARWIN_SANDBOX_EXEC = '/usr/bin/sandbox-exec'

export const sandboxPlatformCheck: DoctorCheck = {
	id: 'sandbox.platform',
	category: 'sandbox',
	run: async (): Promise<DoctorCheckResult> => {
		const platform = process.platform
		switch (platform) {
			case 'darwin':
				try {
					await access(DARWIN_SANDBOX_EXEC, constants.X_OK)
					return {
						status: 'pass',
						message: `darwin / ${DARWIN_SANDBOX_EXEC} present and executable`,
					}
				} catch {
					return {
						status: 'fail',
						message: `darwin / ${DARWIN_SANDBOX_EXEC} not executable`,
						remediation: 'macOS sandboxing requires sandbox-exec; check system integrity.',
					}
				}
			case 'linux':
				return {
					status: 'inconclusive',
					message:
						'linux sandbox capability probe (unshare + namespaces) not implemented in v1; register a custom check via registerDoctorCheck if you need it',
				}
			case 'win32':
				return {
					status: 'warn',
					message: 'windows sandbox is not supported by @namzu/sdk today',
				}
			default:
				return {
					status: 'inconclusive',
					message: `unrecognized platform "${platform}"`,
				}
		}
	},
}

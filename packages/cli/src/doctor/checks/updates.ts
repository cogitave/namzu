import type { DoctorCheck, DoctorCheckContext, DoctorCheckResult } from '@namzu/sdk'

import { currentInstall } from '../../integrations/auto-update/start.js'
import { type UpdateStatusInput, readUpdateStatus } from '../../integrations/auto-update/status.js'
import { CLI_VERSION } from '../../version.js'

/** The check's answer for one install; separate from the check so tests can hand it any layout. */
export function describeUpdates(input: UpdateStatusInput): DoctorCheckResult {
	const status = readUpdateStatus(input)
	switch (status.state) {
		case 'not-applicable':
			return { status: 'skipped', message: 'this copy of Namzu is not updated by Namzu itself' }
		case 'current':
			return { status: 'pass', message: `no newer version known (Namzu ${status.version})` }
		case 'available':
			return {
				status: 'pass',
				message: `Namzu ${status.latest} is available`,
				...(status.command ? { remediation: `Run: ${status.command}` } : {}),
			}
		case 'cannot-install':
			return {
				status: 'warn',
				message: `Namzu ${status.latest} is available, but ${status.reason.charAt(0).toLowerCase()}${status.reason.slice(1)} (${status.folder})${
					status.log ? ` What the installer printed is in ${status.log}` : ''
				}`,
				...(status.command ? { remediation: `Run: ${status.command}` } : {}),
			}
		case 'failed-version':
			return {
				status: 'warn',
				message: `Namzu ${status.latest} did not work on this install. ${status.reason}${
					status.log ? ` What the installer printed is in ${status.log}` : ''
				}`,
			}
	}
}

export const updatesCheck: DoctorCheck = {
	id: 'updates.install',
	category: 'runtime',
	run: (ctx: DoctorCheckContext): Promise<DoctorCheckResult> => {
		const found = currentInstall(ctx.env as NodeJS.ProcessEnv)
		if (!found) return Promise.resolve({ status: 'skipped', message: 'no Namzu home to look in' })
		return Promise.resolve(
			describeUpdates({
				currentVersion: CLI_VERSION,
				install: found.install,
				home: found.home,
				platform: process.platform,
			}),
		)
	},
}

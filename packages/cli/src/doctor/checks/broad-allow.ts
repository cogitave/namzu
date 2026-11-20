import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { readPermissionLayers } from '../../config/load.js'
import type { PermissionLayer } from '../../config/load.js'
import { broadAllowRules, describeBroadAllow } from '../../permissions/broad-allow.js'

/**
 * Whether an allow rule in the permission files allows any program.
 *
 * A `warn` naming each rule, the file it is in and a narrower rule to write
 * instead; a `pass` when every rule names what it runs. The rule still does
 * what it says: this row only says it is wider than it reads.
 */
export function describeBroadAllows(layers: readonly PermissionLayer[]): DoctorCheckResult {
	const found = broadAllowRules(layers)
	if (found.length === 0) {
		return { status: 'pass', message: 'No allow rule lets any program run.' }
	}
	return {
		status: 'warn',
		message: `Permission rules that allow any program: ${found.map(describeBroadAllow).join(' ')}`,
		remediation:
			'Replace each with a rule that names the command it should allow. The rule keeps working as written until you do.',
	}
}

export function broadAllowCheck(): DoctorCheck {
	return {
		id: 'runtime.permission-allow-rules',
		category: 'runtime',
		run: async (ctx): Promise<DoctorCheckResult> => {
			try {
				return describeBroadAllows(readPermissionLayers({ cwd: ctx.cwd }))
			} catch (error) {
				return {
					status: 'skipped',
					message: `The permission files could not be read: ${error instanceof Error ? error.message : String(error)}`,
				}
			}
		},
	}
}

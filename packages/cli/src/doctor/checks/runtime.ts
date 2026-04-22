import { constants, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import type { DoctorCheck, DoctorCheckContext, DoctorCheckResult } from '@namzu/sdk'

export const cwdWritableCheck: DoctorCheck = {
	id: 'runtime.cwd-writable',
	category: 'runtime',
	run: async (ctx: DoctorCheckContext): Promise<DoctorCheckResult> => {
		try {
			await access(ctx.cwd, constants.W_OK)
			return { status: 'pass', message: `cwd writable: ${ctx.cwd}` }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			return {
				status: 'fail',
				message: `cwd not writable: ${ctx.cwd} (${message})`,
				remediation: 'Run from a directory you have write access to, or pass an explicit cwd.',
			}
		}
	},
}

export const tmpdirWritableCheck: DoctorCheck = {
	id: 'runtime.tmpdir-writable',
	category: 'runtime',
	run: async (): Promise<DoctorCheckResult> => {
		const dir = tmpdir()
		try {
			await access(dir, constants.W_OK)
			return { status: 'pass', message: `tmpdir writable: ${dir}` }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			return {
				status: 'fail',
				message: `tmpdir not writable: ${dir} (${message})`,
				remediation: 'Set TMPDIR / TMP / TEMP to a writable location.',
			}
		}
	},
}

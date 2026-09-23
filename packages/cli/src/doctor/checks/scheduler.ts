import { readFileSync, realpathSync } from 'node:fs'
import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'
import { resolveNamzuHome } from '../../integrations/state/home.js'
import { schedulePaths } from '../../schedule/paths.js'
import { readManifest } from '../../schedule/service/manifest.js'
import { listJobs } from '../../schedule/store/jobs.js'

/**
 * The scheduler, as far as files can tell without asking a service manager:
 * whether jobs exist without a scheduler to run them, whether the installed
 * service points at a node and a CLI that still exist, and how long ago the
 * daemon last wrote its heartbeat. `namzu schedule status` asks the service
 * manager too.
 */
export const schedulerCheck: DoctorCheck = {
	id: 'scheduler.service',
	category: 'runtime',
	async run(ctx): Promise<DoctorCheckResult> {
		const paths = schedulePaths(resolveNamzuHome({ env: ctx.env as NodeJS.ProcessEnv }))
		let jobs = 0
		try {
			jobs = listJobs(paths).jobs.filter((j) => j.state === 'active').length
		} catch {
			jobs = 0
		}
		let manifest: ReturnType<typeof readManifest>
		try {
			manifest = readManifest(paths)
		} catch (error) {
			return { status: 'fail', message: error instanceof Error ? error.message : String(error) }
		}
		if (!manifest) {
			return jobs > 0
				? {
						status: 'warn',
						message: `${jobs} active scheduled job(s) and no scheduler installed; they will not run`,
						remediation: 'namzu schedule install',
					}
				: { status: 'skipped', message: 'no scheduled jobs and no scheduler installed' }
		}
		for (const path of [manifest.nodePath, manifest.binPath]) {
			try {
				realpathSync(path)
			} catch {
				return {
					status: 'fail',
					message: `the scheduler service starts ${path}, which no longer exists`,
					remediation: 'namzu schedule install',
				}
			}
		}
		let age: number | undefined
		try {
			const beat = JSON.parse(readFileSync(paths.heartbeat, 'utf8')) as { at?: string }
			age = beat.at ? Date.now() - Date.parse(beat.at) : undefined
		} catch {
			age = undefined
		}
		if (age === undefined || age > 90_000) {
			return {
				status: 'warn',
				message: `${manifest.name} (${manifest.platform}) is installed but the daemon has not been seen ${age === undefined ? 'yet' : `for ${Math.round(age / 1000)} s`}`,
				remediation: 'namzu schedule status',
			}
		}
		return {
			status: 'pass',
			message: `${manifest.name} (${manifest.platform}) running; ${jobs} active job(s)`,
		}
	},
}

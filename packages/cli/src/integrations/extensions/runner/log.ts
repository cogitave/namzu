import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runnerDir } from '../signin/launcher.js'

/** `_runner/daemon.log`: JSON lines, codes and counts only, never a data value; 1 MiB times 3 files. */

export const RUNNER_EVENTS = [
	'runner-start',
	'runner-stop',
	'runner-idle-exit',
	'reconcile',
	'ext-start',
	'ext-stop',
	'signin-registered',
	'signin-removed',
	'signin-disabled-by-os',
	'attach',
	'handover',
] as const
export type RunnerEvent = (typeof RUNNER_EVENTS)[number]

const ROTATE_BYTES = 1024 * 1024
const KEEP = 3

export class RunnerLog {
	constructor(
		private readonly root: string,
		private readonly now: () => number = Date.now,
	) {}
	get file(): string {
		return join(runnerDir(this.root), 'daemon.log')
	}
	write(event: RunnerEvent, detail?: string): void {
		const f = this.file
		try {
			mkdirSync(runnerDir(this.root), { recursive: true, mode: 0o700 })
			try {
				if (statSync(f).size > ROTATE_BYTES) {
					for (let i = KEEP - 1; i >= 1; i--)
						if (existsSync(`${f}.${i}`)) renameSync(`${f}.${i}`, `${f}.${i + 1}`)
					renameSync(f, `${f}.1`)
				}
			} catch {
				// first line
			}
			appendFileSync(
				f,
				`${JSON.stringify({ ts: new Date(this.now()).toISOString(), event, ...(detail ? { detail: detail.slice(0, 200) } : {}) })}\n`,
				{ mode: 0o600 },
			)
		} catch {
			// a log line that cannot be written never stops the work it records
		}
	}
}

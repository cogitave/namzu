import { writeFileSync } from 'node:fs'
import {
	APPROVED_KEY,
	type Exec,
	RUN_KEY,
	RUN_VALUE,
	type RegisterResult,
	type SigninRegistrar,
	type SigninSpec,
	TASK_NAME,
} from './registrar.js'

/**
 * Windows. First choice, a Task Scheduler task at log on for the current user only: it is visible in
 * Task Scheduler (transparency) and restarts the runner on failure. Fallback, `HKCU\...\Run`, which is
 * known to work for a standard user and shows in Settings > Startup apps. No administrator rights are
 * requested and no machine-wide key (`HKLM`) is touched. Whether a standard user can create a log-on task
 * for their own account is NOT verified here: the sandbox run decides it, and either outcome is handled.
 */

const xml = (s: string): string =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function taskXml(spec: SigninSpec, user: string): string {
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts the extensions you chose to run when you sign in.</Description>
    <Author>Namzu</Author>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(spec.launcher)}</Command>
    </Exec>
  </Actions>
</Task>
`
}

/** Task Scheduler wants UTF-16 with a byte-order mark. */
export const utf16Bom = (text: string): Buffer =>
	Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])

export const createTaskArgs = (xmlFile: string): string[] => [
	'/Create',
	'/TN',
	TASK_NAME,
	'/XML',
	xmlFile,
	'/F',
]
export const deleteTaskArgs = (): string[] => ['/Delete', '/TN', TASK_NAME, '/F']
export const queryTaskArgs = (): string[] => ['/Query', '/TN', TASK_NAME, '/XML']
export const addRunArgs = (launcher: string): string[] => [
	'add',
	RUN_KEY,
	'/v',
	RUN_VALUE,
	'/t',
	'REG_SZ',
	'/d',
	`"${launcher}"`,
	'/f',
]
export const deleteRunArgs = (): string[] => ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']
export const queryRunArgs = (): string[] => ['query', RUN_KEY, '/v', RUN_VALUE]
export const queryApprovedArgs = (): string[] => ['query', APPROVED_KEY, '/v', RUN_VALUE]

/** StartupApproved holds a binary value: first byte 02 or 06 is enabled, 03 (or 07) is switched off. */
export function approvedDisabled(stdout: string): boolean {
	const m = /REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(stdout)
	if (!m) return false
	const first = Number.parseInt(m[1] as string, 16)
	return (first & 1) === 1
}

export class WindowsRegistrar implements SigninRegistrar {
	constructor(
		private readonly exec: Exec,
		/** Where the task file is written before it is imported. */
		private readonly xmlFile: string,
		private readonly user: string,
	) {}

	async status() {
		const t = await this.exec('schtasks', queryTaskArgs()).catch(() => undefined)
		if (t && t.code === 0) {
			const off = /<Settings>[\s\S]*?<Enabled>\s*false\s*<\/Enabled>/i.test(t.stdout)
			return { registered: true, kind: 'task' as const, ...(off ? { disabledByOs: true } : {}) }
		}
		const r = await this.exec('reg', queryRunArgs()).catch(() => undefined)
		if (r && r.code === 0 && r.stdout.includes(RUN_VALUE)) {
			const a = await this.exec('reg', queryApprovedArgs()).catch(() => undefined)
			const off = a && a.code === 0 ? approvedDisabled(a.stdout) : false
			return { registered: true, kind: 'run' as const, ...(off ? { disabledByOs: true } : {}) }
		}
		return { registered: false }
	}

	async register(spec: SigninSpec): Promise<RegisterResult> {
		try {
			writeFileSync(this.xmlFile, utf16Bom(taskXml(spec, this.user)), { mode: 0o600 })
			const t = await this.exec('schtasks', createTaskArgs(this.xmlFile))
			if (t.code === 0) {
				// An entry left by an earlier fallback would start the runner twice: one entry only.
				await this.exec('reg', deleteRunArgs()).catch(() => undefined)
				return { ok: true, kind: 'task' }
			}
			const r = await this.exec('reg', addRunArgs(spec.launcher))
			return r.code === 0
				? { ok: true, kind: 'run' }
				: { ok: false, reason: `${t.stderr || t.stdout} ${r.stderr}`.trim() }
		} catch (e) {
			return { ok: false, reason: (e as Error).message }
		}
	}

	async unregister(): Promise<void> {
		await this.exec('schtasks', deleteTaskArgs()).catch(() => undefined)
		await this.exec('reg', deleteRunArgs()).catch(() => undefined)
	}
}

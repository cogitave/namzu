import { writeFileSync } from 'node:fs'
import {
	APPROVED_KEY,
	type Exec,
	RUN_KEY,
	RUN_VALUE,
	type RegisterResult,
	type SigninRegistrar,
	type SigninSpec,
	type SigninStatus,
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

/** The program the sign-in entry runs: the script host with the hidden launcher, or the launcher itself. */
export function entryCommand(spec: SigninSpec): { command: string; args?: string } {
	return spec.hiddenLauncher
		? { command: 'wscript.exe', args: `//B //Nologo "${spec.hiddenLauncher}"` }
		: { command: spec.launcher }
}

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
      <Command>${xml(entryCommand(spec).command)}</Command>${
				entryCommand(spec).args
					? `
      <Arguments>${xml(entryCommand(spec).args as string)}</Arguments>`
					: ''
			}
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
/** The command line the Run key holds. */
export const runValue = (launcher: string, hidden?: string): string =>
	hidden ? `wscript.exe //B //Nologo "${hidden}"` : `"${launcher}"`
export const addRunArgs = (launcher: string, hidden?: string): string[] => [
	'add',
	RUN_KEY,
	'/v',
	RUN_VALUE,
	'/t',
	'REG_SZ',
	'/d',
	runValue(launcher, hidden),
	'/f',
]
export const deleteRunArgs = (): string[] => ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']
export const queryRunArgs = (): string[] => ['query', RUN_KEY, '/v', RUN_VALUE]
export const queryApprovedArgs = (): string[] => ['query', APPROVED_KEY, '/v', RUN_VALUE]

const unxml = (s: string): string =>
	s
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')

/**
 * What decides whether the entry opens a console window: the program it starts and the script it hands
 * that program, by file name. Full paths are not compared: `schtasks` and `reg` print in the console's
 * code page, so a profile folder with letters outside ASCII would never read back equal and the entry
 * would be registered again on every check. A moved folder changes the launcher files, which already
 * registers the entry again.
 */
interface EntryParts {
	readonly program: string
	readonly script: string
}

const fileName = (path: string): string =>
	(path.trim().replace(/^"|"$/g, '').split(/[\\/]/).pop() ?? '').toLowerCase()

/** The last quoted value of an argument string, or its last word. */
const lastValue = (args: string): string =>
	/"([^"]*)"\s*$/.exec(args)?.[1] ?? args.trim().split(/\s+/).pop() ?? ''

/** A whole command line: its first value (quoted or not) is the program. */
function lineParts(line: string): EntryParts {
	const text = line.trim()
	const program = text.startsWith('"')
		? (/^"([^"]*)"/.exec(text)?.[1] ?? '')
		: (text.split(/\s+/)[0] ?? '')
	return { program: fileName(program), script: fileName(lastValue(text)) }
}

const sameParts = (a: EntryParts, b: EntryParts): boolean =>
	a.program === b.program && a.script === b.script

/**
 * Whether a task, as `schtasks /Query /XML` prints it, runs a program or script other than the one this
 * spec wants. `undefined` when the XML has no command to read, so an unreadable answer never loops a repair.
 */
export function taskIsStale(queried: string, spec: SigninSpec): boolean | undefined {
	const exec = /<Exec>([\s\S]*?)<\/Exec>/i.exec(queried)?.[1]
	const command = exec && /<Command>([\s\S]*?)<\/Command>/i.exec(exec)?.[1]
	if (command === undefined || command.trim() === '') return undefined
	const args = /<Arguments>([\s\S]*?)<\/Arguments>/i.exec(exec as string)?.[1] ?? ''
	const parts = (c: string, a: string): EntryParts => ({
		program: fileName(c),
		script: fileName(a.trim() ? lastValue(a) : c),
	})
	const want = entryCommand(spec)
	return !sameParts(parts(unxml(command), unxml(args)), parts(want.command, want.args ?? ''))
}

/** Whether the Run value, as `reg query` prints it, starts a program or script other than this spec's. */
export function runIsStale(queried: string, spec: SigninSpec): boolean | undefined {
	const data = new RegExp(`${RUN_VALUE}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'm').exec(queried)?.[1]
	if (data === undefined || data.trim() === '') return undefined
	return !sameParts(lineParts(data), lineParts(runValue(spec.launcher, spec.hiddenLauncher)))
}

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

	async status(spec?: SigninSpec): Promise<SigninStatus> {
		const t = await this.exec('schtasks', queryTaskArgs()).catch(() => undefined)
		if (t && t.code === 0) {
			const off = /<Settings>[\s\S]*?<Enabled>\s*false\s*<\/Enabled>/i.test(t.stdout)
			const stale = spec ? taskIsStale(t.stdout, spec) === true : false
			return {
				registered: true,
				kind: 'task' as const,
				...(off ? { disabledByOs: true } : {}),
				...(stale ? { stale: true } : {}),
			}
		}
		const r = await this.exec('reg', queryRunArgs()).catch(() => undefined)
		if (r && r.code === 0 && r.stdout.includes(RUN_VALUE)) {
			const a = await this.exec('reg', queryApprovedArgs()).catch(() => undefined)
			const off = a && a.code === 0 ? approvedDisabled(a.stdout) : false
			const stale = spec ? runIsStale(r.stdout, spec) === true : false
			return {
				registered: true,
				kind: 'run' as const,
				...(off ? { disabledByOs: true } : {}),
				...(stale ? { stale: true } : {}),
			}
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
			const r = await this.exec('reg', addRunArgs(spec.launcher, spec.hiddenLauncher))
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

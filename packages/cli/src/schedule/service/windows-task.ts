/**
 * Windows Task Scheduler, natively and from WSL.
 *
 * Two triggers: at the user's logon, and a time trigger that repeats every
 * five minutes forever. Task Scheduler's restart-on-failure reacts to a task
 * that fails to LAUNCH, not to a non-zero exit, so after `wsl --shutdown` or a
 * crash only the repetition brings the daemon back. `IgnoreNew` makes a
 * repetition a no-op while the daemon runs; `schedule stop` therefore DISABLES
 * the task (ending it would be undone within five minutes).
 *
 * The task names its user (`DOMAIN\user`) on the principal and on the logon
 * trigger: a logon trigger without one applies to every user and needs
 * elevation to register. "Run only when the user is logged on"
 * (InteractiveToken): WSL fails to start from a non-interactive task.
 *
 * `schtasks /XML` reads UTF-16; the file is written UTF-16LE with a BOM to
 * match its declaration.
 */

import { windowsArgument, xmlText } from './quote.js'

export interface TaskDefinition {
	/** `DOMAIN\user`, from `whoami.exe`. */
	readonly userId: string
	readonly description: string
	/** Windows path of the program. */
	readonly command: string
	readonly args: readonly string[]
	/** When the repetition starts; any past instant. */
	readonly startBoundary?: string
}

export function taskXml(task: TaskDefinition): string {
	const start = task.startBoundary ?? '2026-01-01T00:00:00'
	return [
		'<?xml version="1.0" encoding="UTF-16"?>',
		'<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
		'  <RegistrationInfo>',
		`    <Description>${xmlText(task.description)}</Description>`,
		`    <Author>${xmlText(task.userId)}</Author>`,
		'  </RegistrationInfo>',
		'  <Triggers>',
		'    <LogonTrigger>',
		'      <Enabled>true</Enabled>',
		`      <UserId>${xmlText(task.userId)}</UserId>`,
		'    </LogonTrigger>',
		'    <TimeTrigger>',
		'      <Repetition>',
		'        <Interval>PT5M</Interval>',
		'        <StopAtDurationEnd>false</StopAtDurationEnd>',
		'      </Repetition>',
		`      <StartBoundary>${xmlText(start)}</StartBoundary>`,
		'      <Enabled>true</Enabled>',
		'    </TimeTrigger>',
		'  </Triggers>',
		'  <Principals>',
		'    <Principal id="Author">',
		`      <UserId>${xmlText(task.userId)}</UserId>`,
		'      <LogonType>InteractiveToken</LogonType>',
		'      <RunLevel>LeastPrivilege</RunLevel>',
		'    </Principal>',
		'  </Principals>',
		'  <Settings>',
		'    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
		'    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
		'    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
		'    <AllowHardTerminate>true</AllowHardTerminate>',
		'    <StartWhenAvailable>true</StartWhenAvailable>',
		'    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
		'    <IdleSettings>',
		'      <StopOnIdleEnd>false</StopOnIdleEnd>',
		'      <RestartOnIdle>false</RestartOnIdle>',
		'    </IdleSettings>',
		'    <AllowStartOnDemand>true</AllowStartOnDemand>',
		'    <Enabled>true</Enabled>',
		'    <Hidden>false</Hidden>',
		'    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
		'    <WakeToRun>false</WakeToRun>',
		'    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
		'    <Priority>7</Priority>',
		'  </Settings>',
		'  <Actions Context="Author">',
		'    <Exec>',
		`      <Command>${xmlText(task.command)}</Command>`,
		`      <Arguments>${xmlText(task.args.map(windowsArgument).join(' '))}</Arguments>`,
		'    </Exec>',
		'  </Actions>',
		'</Task>',
		'',
	].join('\r\n')
}

/** The task file's bytes: UTF-16LE with a byte-order mark. */
export function taskXmlBytes(xml: string): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])
}

/** The task's path in the scheduler's library. */
export function taskPath(name: string): string {
	return `\\namzu\\${name}`
}

/**
 * Delete the `\namzu` Task Scheduler folder that `/Create` made, when no
 * task (hidden ones included) and no subfolder is left in it. `schtasks
 * /Delete` removes a task and never its folder, and `schtasks /Query` does not
 * show an empty folder, so without this an uninstall left one behind.
 * Exits 1 only when the folder is still there and empty. A constant: nothing
 * is interpolated into it.
 */
export const REMOVE_EMPTY_TASK_FOLDER_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	'$s = New-Object -ComObject Schedule.Service',
	'$s.Connect()',
	"try { $f = $s.GetFolder('\\namzu') } catch { exit 0 }",
	'if ($f.GetTasks(1).Count -gt 0 -or $f.GetFolders(0).Count -gt 0) { exit 0 }',
	"try { $s.GetFolder('\\').DeleteFolder('namzu', 0) } catch { exit 1 }",
	'exit 0',
].join('; ')

/** `powershell.exe` arguments that run {@link REMOVE_EMPTY_TASK_FOLDER_SCRIPT}. */
export function removeEmptyTaskFolderArguments(): string[] {
	return [
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-EncodedCommand',
		Buffer.from(REMOVE_EMPTY_TASK_FOLDER_SCRIPT, 'utf16le').toString('base64'),
	]
}

/** `schtasks /Query … /FO LIST /V` → the fields a status line needs. */
export function parseTaskQuery(output: string): {
	status?: string
	state?: string
	lastResult?: string
} {
	const field = (label: RegExp): string | undefined => {
		for (const line of output.split(/\r?\n/)) {
			const match = /^([^:]+):\s*(.*)$/.exec(line)
			if (match && label.test((match[1] ?? '').trim())) return (match[2] ?? '').trim()
		}
		return undefined
	}
	const status = field(/^Status$/i)
	const state = field(/^Scheduled Task State$/i)
	const lastResult = field(/^Last Result$/i)
	return {
		...(status !== undefined ? { status } : {}),
		...(state !== undefined ? { state } : {}),
		...(lastResult !== undefined ? { lastResult } : {}),
	}
}

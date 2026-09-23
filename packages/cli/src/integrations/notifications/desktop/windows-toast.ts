/**
 * A Windows toast through PowerShell and the WinRT notification API — no
 * module to install. Used natively and from WSL (through interop).
 *
 * The script is a CONSTANT, sent as `-EncodedCommand` with no arguments after
 * it: `-Command` would join trailing arguments into the script text, which is
 * exactly the injection this avoids. The title and body reach it only through
 * the environment (`NAMZU_NOTIFY_TITLE`, `NAMZU_NOTIFY_BODY`) and are
 * XML-escaped inside the script before they touch the toast's XML.
 */

import { createHash } from 'node:crypto'

export const TOAST_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	'[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
	'[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
	'$title = [Security.SecurityElement]::Escape([string]$env:NAMZU_NOTIFY_TITLE)',
	'$body = [Security.SecurityElement]::Escape([string]$env:NAMZU_NOTIFY_BODY)',
	'$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
	"$xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>' + $title + '</text><text>' + $body + '</text></binding></visual></toast>')",
	"$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
	'[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
].join('\n')

/** The script as `-EncodedCommand` wants it: base64 of UTF-16LE. */
export function encodedToastScript(): string {
	return Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64')
}

/** For a test: the script never changes with its input. */
export function toastScriptHash(): string {
	return createHash('sha256').update(TOAST_SCRIPT).digest('hex')
}

export function toastArguments(): string[] {
	return [
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-EncodedCommand',
		encodedToastScript(),
	]
}

/**
 * The environment for the PowerShell process. Under WSL a Linux variable
 * reaches a Windows process only when `WSLENV` names it; without this the
 * toast would arrive empty.
 */
export function toastEnvironment(
	base: NodeJS.ProcessEnv,
	title: string,
	body: string,
	wsl: boolean,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base, NAMZU_NOTIFY_TITLE: title, NAMZU_NOTIFY_BODY: body }
	if (wsl) {
		const existing = (base.WSLENV ?? '')
			.split(':')
			.filter((v) => v && !v.startsWith('NAMZU_NOTIFY_'))
		env.WSLENV = [...existing, 'NAMZU_NOTIFY_TITLE', 'NAMZU_NOTIFY_BODY'].join(':')
	}
	return env
}

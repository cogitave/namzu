/**
 * The per-user sign-in entry. One entry for all background extensions, never one per extension. It names
 * only Namzu's own generated launcher, never an extension's binary, so every rule of the host (signature
 * and hash check, licence, consent, clean environment) holds while the app is closed. Registrars sit
 * behind this one interface so a test uses an in-memory fake and a dry mode that runs nothing.
 */

export type SigninKind = 'task' | 'run' | 'xdg' | 'launchagent'

export interface SigninSpec {
	/** Absolute path of the generated launcher (`start.cmd` or `start.sh`). */
	readonly launcher: string
	/** Windows: the script that runs the launcher with no window. The entry names it when present. */
	readonly hiddenLauncher?: string
}

export interface SigninStatus {
	readonly registered: boolean
	readonly kind?: SigninKind
	/** The person (or the system) switched the entry off in the operating system. Namzu never re-enables it. */
	readonly disabledByOs?: boolean
}

export type RegisterResult = { ok: true; kind: SigninKind } | { ok: false; reason: string }

export interface SigninRegistrar {
	status(): Promise<SigninStatus>
	register(spec: SigninSpec): Promise<RegisterResult>
	unregister(): Promise<void>
}

export interface ExecResult {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}
/** Runs a program with an argument list: never through a shell. */
export type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>

export const TASK_NAME = '\\Namzu\\Extension Runner'
export const RUN_VALUE = 'NamzuExtensionRunner'
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const APPROVED_KEY =
	'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
export const XDG_FILE = 'namzu-extension-runner.desktop'
export const LAUNCH_LABEL = 'dev.namzu.extension-runner'

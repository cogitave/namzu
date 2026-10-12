import { LocalCommandError } from '../engine.js'
import type { ClearResumeAtSignIn, RegisterResumeAtSignIn, WslcSetupHost } from './contract.js'
import { trustedWindowsDirectory } from './windows-folder.js'

/** The registry value the resume command is stored under. */
const RESUME_VALUE_NAME = 'NamzuPalComputerSetup'
/** Windows runs a RunOnce command line of at most this many characters. */
const MAX_COMMAND_LENGTH = 2048

function regBinary(host: WslcSetupHost): string {
	return `${trustedWindowsDirectory(host.env)}\\System32\\reg.exe`
}

function checkKey(key: string): void {
	if (!/^HK(CU|LM|CR|U|CC)\\[^\r\n\0"]+$/.test(key)) {
		throw new Error('The sign-in registry key is not a valid registry path.')
	}
}

function checkCommand(command: string): void {
	if (command.trim().length === 0) throw new Error('The sign-in command is empty.')
	if (command.length > MAX_COMMAND_LENGTH) {
		throw new Error(`The sign-in command is longer than ${MAX_COMMAND_LENGTH} characters.`)
	}
	if (/[\r\n\0]/.test(command)) {
		throw new Error('The sign-in command must be a single line.')
	}
}

/**
 * Ask Windows to run `command` once at the next sign-in by writing the
 * `NamzuPalComputerSetup` value (REG_SZ) under `host.resumeRegistryKey`. No
 * administrator is needed for the default per-user key. Windows deletes a
 * RunOnce value just before it runs it; writing the value again replaces it.
 */
export const registerResumeAtSignIn: RegisterResumeAtSignIn = async (host, command) => {
	checkKey(host.resumeRegistryKey)
	checkCommand(command)
	await host.runner.run(regBinary(host), [
		'add',
		host.resumeRegistryKey,
		'/v',
		RESUME_VALUE_NAME,
		'/t',
		'REG_SZ',
		'/d',
		command,
		'/f',
	])
}

/** Take the command back. A value that is not there is not an error. */
export const clearResumeAtSignIn: ClearResumeAtSignIn = async (host) => {
	checkKey(host.resumeRegistryKey)
	const reg = regBinary(host)
	try {
		await host.runner.run(reg, ['query', host.resumeRegistryKey, '/v', RESUME_VALUE_NAME])
	} catch (error) {
		// `reg query` exits 1 when the key or the value is absent: nothing to
		// delete. Any other failure (access denied, a timeout, a missing tool) is
		// not "absent" and is the caller's to see.
		if (error instanceof LocalCommandError && error.exitCode === 1) return
		throw error
	}
	await host.runner.run(reg, ['delete', host.resumeRegistryKey, '/v', RESUME_VALUE_NAME, '/f'])
}

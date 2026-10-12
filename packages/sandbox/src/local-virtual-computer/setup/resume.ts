import type { ClearResumeAtSignIn, RegisterResumeAtSignIn, WslcSetupHost } from './contract.js'
import { listingHasValue, queryRegistryKey } from './registry.js'
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

/**
 * Take the command back. A value that is not there is not an error; a key
 * that cannot be read is, because the command might still be registered.
 */
export const clearResumeAtSignIn: ClearResumeAtSignIn = async (host) => {
	checkKey(host.resumeRegistryKey)
	const reg = regBinary(host)
	const listing = await queryRegistryKey(
		(args) => host.runner.run(reg, [...args]),
		host.resumeRegistryKey,
	)
	if (listing === undefined || !listingHasValue(listing, RESUME_VALUE_NAME)) return
	await host.runner.run(reg, ['delete', host.resumeRegistryKey, '/v', RESUME_VALUE_NAME, '/f'])
}

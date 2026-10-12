import { homedir, release } from 'node:os'
import { join, win32 } from 'node:path'
import { LocalCommandError, nodeCommandRunner } from '../engine.js'
import { type CreateWslcSetupHost, RESUME_AT_SIGN_IN_KEY } from './contract.js'
import { PROBE_LIMIT_MS, ProbeTimeoutError, runLimited } from './limits.js'

/** `10.0.19045` becomes 19045; undefined when the release string has no build. */
function windowsBuildOf(platform: NodeJS.Platform): number | undefined {
	if (platform !== 'win32') return undefined
	const build = Number(release().split('.')[2])
	return Number.isInteger(build) ? build : undefined
}

/**
 * The processor type of the PC. On Windows a 32-bit process sees its own
 * type in `PROCESSOR_ARCHITECTURE`; the PC's is in `PROCESSOR_ARCHITEW6432`.
 * Neither is `process.arch`, which names the Node build, not the machine.
 */
export function windowsArchitectureOf(env: NodeJS.ProcessEnv): string {
	const claimed = (env.PROCESSOR_ARCHITEW6432 ?? env.PROCESSOR_ARCHITECTURE ?? '').toUpperCase()
	if (claimed === 'AMD64') return 'x64'
	if (claimed === 'ARM64') return 'arm64'
	return claimed === '' ? process.arch : claimed.toLowerCase()
}

function defaultStateDirectory(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	if (platform === 'win32') {
		const base = env.LOCALAPPDATA ?? win32.join(homedir(), 'AppData', 'Local')
		return win32.join(base, 'Namzu', 'setup')
	}
	return join(homedir(), '.namzu', 'setup')
}

/** `REG_DWORD    0x1f` becomes 31; anything else is undefined. */
export function parseRegDword(output: string): number | undefined {
	const match = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(output)
	return match ? Number.parseInt(match[1] as string, 16) : undefined
}

/** The real Windows host, with `overrides` applied. */
export const createWslcSetupHost: CreateWslcSetupHost = (overrides = {}) => {
	const platform = overrides.platform ?? process.platform
	const env = overrides.env ?? process.env
	const runner = overrides.runner ?? nodeCommandRunner
	const host = {
		platform,
		arch: platform === 'win32' ? windowsArchitectureOf(env) : process.arch,
		windowsBuild: windowsBuildOf(platform),
		env,
		runner,
		stateDirectory: defaultStateDirectory(env, platform),
		resumeRegistryKey: RESUME_AT_SIGN_IN_KEY,
		now: () => new Date(),
		async readDword(key: string, name: string): Promise<number | undefined> {
			try {
				return parseRegDword(
					await runLimited(runner, 'reg.exe', ['query', key, '/v', name], PROBE_LIMIT_MS.command),
				)
			} catch (error) {
				// reg.exe exits 1 for an absent key or value; that is "not set". A
				// check that did not answer in time is not known, which reads the same.
				if (error instanceof LocalCommandError || error instanceof ProbeTimeoutError)
					return undefined
				throw error
			}
		},
		async keyExists(key: string): Promise<boolean | 'unknown'> {
			try {
				await runLimited(runner, 'reg.exe', ['query', key], PROBE_LIMIT_MS.command)
				return true
			} catch (error) {
				if (error instanceof LocalCommandError) return error.exitCode === 1 ? false : 'unknown'
				if (error instanceof ProbeTimeoutError) return 'unknown'
				throw error
			}
		},
		async bootTime(): Promise<Date> {
			const output = await runLimited(
				runner,
				'powershell.exe',
				[
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					"(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
				],
				PROBE_LIMIT_MS.powershell,
			)
			const parsed = new Date(output.trim())
			if (Number.isNaN(parsed.getTime())) throw new Error('Windows did not report its boot time')
			return parsed
		},
	}
	return { ...host, ...overrides }
}

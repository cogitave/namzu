import { join } from 'node:path'

/**
 * The environment a Pal computer needs from Desktop. On Windows the computer runs on the Linux
 * container support Windows ships, unless the person already chose an engine; when the installer
 * carried the Pal computer, the runtime is told where it is. Off Windows nothing is set, so Docker
 * stays the default and today's help stays as it is.
 */
export function palComputerEnvironment(options: {
	platform: NodeJS.Platform
	env: NodeJS.ProcessEnv
	resourcesPath: string
	exists: (path: string) => boolean
}): Record<string, string> {
	if (options.platform !== 'win32') return {}
	const added: Record<string, string> = {}
	if (options.env.NAMZU_PAL_COMPUTER_ENGINE === undefined) added.NAMZU_PAL_COMPUTER_ENGINE = 'wslc'
	const engine = options.env.NAMZU_PAL_COMPUTER_ENGINE ?? added.NAMZU_PAL_COMPUTER_ENGINE
	const folder = join(options.resourcesPath, 'pal-computer')
	if (
		engine === 'wslc' &&
		options.env.NAMZU_PAL_COMPUTER_BUNDLE === undefined &&
		options.exists(join(folder, 'manifest.json'))
	)
		added.NAMZU_PAL_COMPUTER_BUNDLE = folder
	return added
}

/** How long no Pal computer has to run before the Linux machine is shut down. */
export const PAL_COMPUTER_IDLE_MS = 10 * 60 * 1000

export interface PalComputerSetupSettings {
	/** Whether Desktop drives `namzu computer` at all. */
	enabled: boolean
	idleMs: number
}

/**
 * Setup is Desktop's job only where the engine is the Windows one. `NAMZU_E2E_PAL_COMPUTER_SETUP`
 * lets an end-to-end run stand in for Windows with a scripted CLI, and
 * `NAMZU_E2E_PAL_COMPUTER_IDLE_MS` shortens the idle delay for such a run; nothing else may.
 */
export function palComputerSetupSettings(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): PalComputerSetupSettings {
	const e2e = env.NAMZU_E2E_PAL_COMPUTER_SETUP === '1'
	const override = Number(env.NAMZU_E2E_PAL_COMPUTER_IDLE_MS)
	return {
		enabled: e2e || (platform === 'win32' && env.NAMZU_PAL_COMPUTER_ENGINE === 'wslc'),
		idleMs:
			Number.isFinite(override) && override >= 1000 && env.NAMZU_E2E_PAL_COMPUTER_IDLE_MS
				? override
				: PAL_COMPUTER_IDLE_MS,
	}
}

/** The flag Windows starts Namzu with at the next sign-in to go on with setup. */
export const CONTINUE_SETUP_FLAG = '--continue-pal-computer-setup'

export function continueSetupCommand(executable: string): string {
	return `"${executable}" ${CONTINUE_SETUP_FLAG}`
}

/** The command that restarts Windows; run only when the person pressed "Restart now". */
export function restartCommand(
	platform: NodeJS.Platform,
): { program: string; args: string[] } | undefined {
	return platform === 'win32' ? { program: 'shutdown.exe', args: ['/r', '/t', '0'] } : undefined
}

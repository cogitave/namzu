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
	packaged = false,
): PalComputerSetupSettings {
	// A packaged build is what people run: the end-to-end overrides do nothing there.
	const e2e = !packaged && env.NAMZU_E2E_PAL_COMPUTER_SETUP === '1'
	const override = packaged ? Number.NaN : Number(env.NAMZU_E2E_PAL_COMPUTER_IDLE_MS)
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

export interface RestartHost {
	platform: NodeJS.Platform
	/** Whether setup is waiting for a restart: the only time "Restart now" does anything. */
	due: boolean
	spawn: (
		program: string,
		args: string[],
		options: { detached: true; stdio: 'ignore'; windowsHide: true },
	) => {
		once(event: 'error', listener: (error: Error) => void): unknown
		unref(): unknown
	}
	/** Called when the restart command could not start. */
	onError: (error: Error) => void
}

/** The handler behind "Restart now". Never runs unless the person pressed it and a restart is due. */
export function restartPc(host: RestartHost): void {
	const restart = restartCommand(host.platform)
	if (!restart || !host.due)
		throw new Error('Windows does not need a restart for Pal computers right now.')
	let child: ReturnType<RestartHost['spawn']>
	try {
		child = host.spawn(restart.program, restart.args, {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
		})
	} catch (error) {
		host.onError(error instanceof Error ? error : new Error(String(error)))
		throw new Error(
			'Windows could not be restarted from here. Restart it yourself from the Start menu.',
		)
	}
	// A command that cannot start must not crash the app; the person restarts from the Start menu.
	child.once('error', host.onError)
	child.unref()
}

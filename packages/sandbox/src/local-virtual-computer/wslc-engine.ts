import { access } from 'node:fs/promises'
import { win32 } from 'node:path'
import {
	LocalCommandError,
	type LocalComputerCommandRunner,
	type LocalComputerSetupCode,
	LocalComputerSetupError,
	type LocalEngine,
	nodeCommandRunner,
} from './engine.js'

/** The oldest wslc runtime the provider is verified against. */
export const WSLC_MINIMUM_VERSION = [2, 9, 3] as const

export interface LocalWslcEngineOptions {
	/** Path to wslc.exe. Defaults to the WSL install directory, then PATH. */
	readonly wslcBinary?: string
	readonly runner?: LocalComputerCommandRunner
}

const MESSAGES: Record<LocalComputerSetupCode, string> = {
	'engine-missing': 'Windows Linux container support (wslc) is not installed on this PC.',
	'engine-too-old': 'Windows Linux container support on this PC is too old for Namzu.',
	'virtualization-off':
		'This PC has virtualization switched off. Turn it on in the PC startup settings, then try again.',
	'blocked-by-policy': 'Your organisation does not allow Linux containers on this PC.',
	'image-missing':
		'The Pal computer is not set up on this PC yet. Namzu sets it up; finish the setup from the Pal computer and try again.',
	'sdk-mismatch': "Namzu needs an update to work with this version of Windows' Linux support.",
}

export function wslcSetupError(code: LocalComputerSetupCode, cause?: unknown) {
	return new LocalComputerSetupError(MESSAGES[code], code, cause ? { cause } : undefined)
}

/**
 * Turn the machine-readable codes of a failed wslc command into a typed
 * setup error. Anything unrecognised stays an ordinary failure.
 */
export function mapWslcFailure(error: unknown): LocalComputerSetupError | undefined {
	if (error instanceof LocalComputerSetupError) return undefined
	const codes = new Set(error instanceof LocalCommandError ? error.errorCodes : [])
	if (codes.has('0x80370102') || codes.has('HCS_E_HYPERV_NOT_INSTALLED'))
		return wslcSetupError('virtualization-off', error)
	if (codes.has('0x8004060C') || codes.has('WSLC_E_CONTAINER_DISABLED'))
		return wslcSetupError('blocked-by-policy', error)
	if (codes.has('0x8004060B') || codes.has('WSLC_E_SDK_UPDATE_NEEDED'))
		return wslcSetupError('sdk-mismatch', error)
	if (codes.has('WSLC_E_IMAGE_NOT_FOUND')) return wslcSetupError('image-missing', error)
	if (codes.has('ENOENT')) return wslcSetupError('engine-missing', error)
	return undefined
}

/** Parse the first line of `wslc version`, for example `wslc 3.0.1.0`. */
export function parseWslcVersion(output: string): [number, number, number] | undefined {
	const match = /^\s*wslc\s+(\d+)\.(\d+)\.(\d+)/im.exec(output)
	if (!match) return undefined
	return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function atLeast(found: readonly number[], floor: readonly number[]): boolean {
	for (let i = 0; i < floor.length; i++) {
		if ((found[i] ?? 0) !== floor[i]) return (found[i] ?? 0) > (floor[i] ?? 0)
	}
	return true
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

export interface WslcHost {
	readonly platform?: NodeJS.Platform
	readonly env?: NodeJS.ProcessEnv
	readonly exists?: (path: string) => Promise<boolean>
}

async function resolveBinary(options: LocalWslcEngineOptions, host: WslcHost): Promise<string> {
	if (options.wslcBinary) return options.wslcBinary
	const platform = host.platform ?? process.platform
	const programFiles = (host.env ?? process.env).ProgramFiles
	if (platform === 'win32' && programFiles) {
		const installed = win32.join(programFiles, 'WSL', 'wslc.exe')
		if (await (host.exists ?? exists)(installed)) return installed
	}
	return 'wslc'
}

/**
 * Find a working wslc and prove its session starts. Never installs or updates
 * anything: setup is a separate, consented operation.
 */
export async function resolveLocalWslcEngine(
	options: LocalWslcEngineOptions,
	signal?: AbortSignal,
	host: WslcHost = {},
): Promise<LocalEngine> {
	const binary = await resolveBinary(options, host)
	const runner = options.runner ?? nodeCommandRunner
	const run: LocalEngine['run'] = async (args, call) => {
		try {
			return await runner.run(binary, args, { ...call, env: { ...process.env, ...call?.env } })
		} catch (error) {
			throw mapWslcFailure(error) ?? error
		}
	}
	const version = parseWslcVersion(await run(['version'], { signal }))
	if (!version) throw wslcSetupError('engine-missing')
	if (!atLeast(version, WSLC_MINIMUM_VERSION))
		throw new LocalComputerSetupError(
			`Windows Linux container support on this PC (${version.join('.')}) is too old; ${WSLC_MINIMUM_VERSION.join('.')} or newer is required.`,
			'engine-too-old',
		)
	// The first command that needs the session starts its virtual machine, so
	// this is where "virtualization is off" and "blocked by policy" surface.
	await run(['ps', '-a', '-q'], { signal })
	return { endpoint: 'wslc://local', dialect: 'wslc', run }
}

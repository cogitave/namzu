import { spawn } from 'node:child_process'

/** Stable reasons a caller can branch on without parsing prose. */
export type LocalComputerSetupCode =
	| 'engine-missing'
	| 'engine-too-old'
	| 'virtualization-off'
	| 'blocked-by-policy'
	| 'image-missing'
	| 'sdk-mismatch'

/** Safe operator-facing diagnosis, without daemon output or credentials. */
export class LocalComputerSetupError extends Error {
	override readonly name = 'LocalComputerSetupError'
	readonly code?: LocalComputerSetupCode
	constructor(message: string, code?: LocalComputerSetupCode, options?: { cause?: unknown }) {
		super(message, options)
		this.code = code
	}
}

/**
 * A failed engine command. The message never carries engine output; only
 * recognised machine-readable codes (HRESULTs, WSLC_E_* names, spawn errno
 * names) survive, so a typed diagnosis can be made without leaking text.
 */
export class LocalCommandError extends Error {
	override readonly name = 'LocalCommandError'
	readonly errorCodes: readonly string[]
	constructor(message: string, errorCodes: readonly string[] = []) {
		super(message)
		this.errorCodes = errorCodes
	}
}

const ERROR_CODE_PATTERN = /WSLC_E_[A-Z0-9_]+|HCS_E_[A-Z0-9_]+|0x[0-9A-Fa-f]{8}/g

/** Extract the codes worth keeping from a command's stderr. */
export function extractErrorCodes(text: string): string[] {
	const found = new Set<string>()
	for (const match of text.match(ERROR_CODE_PATTERN) ?? []) {
		found.add(match.startsWith('0x') ? `0x${match.slice(2).toUpperCase()}` : match)
	}
	return [...found]
}

/** Which command-line dialect an engine speaks. */
export type EngineDialect = 'docker' | 'podman' | 'wslc'

/** A host-controlled transport. Never pass this or its environment to an agent. */
export interface LocalComputerCommandRunner {
	run(
		binary: string,
		args: readonly string[],
		options?: {
			readonly signal?: AbortSignal
			readonly env?: NodeJS.ProcessEnv
			readonly cwd?: string
		},
	): Promise<string>
}

export const nodeCommandRunner: LocalComputerCommandRunner = {
	run(binary, args, options) {
		options?.signal?.throwIfAborted()
		return new Promise((resolve, reject) => {
			const child = spawn(binary, [...args], {
				env: options?.env ?? process.env,
				cwd: options?.cwd,
				signal: options?.signal,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			const output: Buffer[] = []
			const diagnostics: Buffer[] = []
			let diagnosticBytes = 0
			let outputBytes = 0
			let failed = false
			child.stdout.on('data', (chunk: Buffer) => {
				output.push(chunk)
				outputBytes += chunk.byteLength
				if (outputBytes > 1024 * 1024) {
					failed = true
					child.kill()
				}
			})
			// Docker's error text can echo worker configuration. Preserve the exit
			// code, never stdout/stderr or the environment in a failure message.
			child.stderr.on('data', (chunk: Buffer) => {
				if (diagnosticBytes >= 64 * 1024) return
				diagnostics.push(chunk)
				diagnosticBytes += chunk.byteLength
			})
			child.once('error', (error: NodeJS.ErrnoException) =>
				reject(
					new LocalCommandError(
						'The local container engine could not be started',
						error.code ? [error.code] : [],
					),
				),
			)
			child.once('close', (code) => {
				if (failed) reject(new Error('The local container engine response exceeded its size limit'))
				else if (code !== 0)
					reject(
						new LocalCommandError(
							`The local container engine command failed (${code})`,
							extractErrorCodes(Buffer.concat(diagnostics).toString('utf8')),
						),
					)
				else {
					const bytes = Buffer.concat(output)
					// Native wsl.exe emits UTF-16LE through a redirected pipe.
					const utf16 = bytes[1] === 0 || (bytes[0] === 0xff && bytes[1] === 0xfe)
					resolve(bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''))
				}
			})
		})
	},
}

/** TCP, SSH and remote named pipes cannot establish a local-device boundary. */
export function assertLocalEngineEndpoint(endpoint: string): void {
	if (/^unix:\/\/\/[\S]+$/.test(endpoint)) return
	if (/^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_.-]+$/.test(endpoint)) return
	throw new LocalComputerSetupError(
		'Pals require a local Docker Unix socket or Windows named pipe; remote engines are refused',
	)
}

export interface LocalEngineOptions {
	readonly dockerBinary?: string
	readonly engineEndpoint?: string
	readonly runner?: LocalComputerCommandRunner
}

export interface LocalEngine {
	readonly endpoint: string
	/** Command-line dialect. Absent means the engine was selected as Docker. */
	readonly dialect?: EngineDialect
	forwardPorts?(
		ports: readonly number[],
		options: { readonly signal?: AbortSignal; readonly onLost: () => void },
	): Promise<LocalPortForward>
	run(
		args: readonly string[],
		options?: { readonly signal?: AbortSignal; readonly env?: NodeJS.ProcessEnv },
	): Promise<string>
}

export interface LocalPortForward {
	readonly ports: readonly number[]
	assertAlive(): void
	close(): Promise<void>
}

/** Resolve once, then pin every operation to the verified endpoint. */
export async function resolveLocalEngine(
	options: LocalEngineOptions,
	signal?: AbortSignal,
): Promise<LocalEngine> {
	const binary = options.dockerBinary ?? 'docker'
	const runner = options.runner ?? nodeCommandRunner
	let endpoint = options.engineEndpoint
	if (endpoint === undefined) {
		const current = (await runner.run(binary, ['context', 'show'], { signal })).trim()
		if (!current)
			throw new LocalComputerSetupError('The current Docker context could not be determined')
		const contexts = JSON.parse(
			await runner.run(binary, ['context', 'inspect', current], { signal }),
		) as { Endpoints?: { docker?: { Host?: string } } }[]
		endpoint = contexts[0]?.Endpoints?.docker?.Host
		// DOCKER_HOST overrides a context in normal Docker invocations. Honor
		// its actual destination and validate it rather than checking one
		// endpoint while accidentally provisioning on another.
		if (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) endpoint = process.env.DOCKER_HOST
	}
	if (!endpoint) throw new LocalComputerSetupError('Docker did not provide a local engine endpoint')
	assertLocalEngineEndpoint(endpoint)
	const host = endpoint
	const run: LocalEngine['run'] = (args, call) => {
		const env = { ...process.env, ...call?.env }
		env.DOCKER_CONTEXT = undefined
		env.DOCKER_HOST = undefined
		return runner.run(binary, ['--host', host, ...args], { ...call, env })
	}
	const info = JSON.parse(await run(['info', '--format', '{{json .}}'], { signal })) as {
		OSType?: string
	}
	if (info.OSType !== 'linux')
		throw new LocalComputerSetupError('The local Docker engine must run Linux containers')
	return { endpoint: host, run }
}

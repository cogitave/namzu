import { spawn } from 'node:child_process'

/** Safe operator-facing diagnosis, without daemon output or credentials. */
export class LocalComputerSetupError extends Error {
	override readonly name = 'LocalComputerSetupError'
}

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
			child.stderr.resume()
			child.once('error', () =>
				reject(new Error('The local container engine could not be started')),
			)
			child.once('close', (code) => {
				if (failed) reject(new Error('The local container engine response exceeded its size limit'))
				else if (code !== 0)
					reject(new Error(`The local container engine command failed (${code})`))
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

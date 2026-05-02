/**
 * `container:docker` backend.
 *
 * Spawns one Docker container per `Sandbox` instance via the
 * `docker` CLI (no node-docker SDK dependency — keeps the package
 * thin). The container runs the small HTTP worker shipped under
 * `packages/sandbox/worker/server.js`; the host adapter talks to
 * it on `127.0.0.1:<random-port>`.
 *
 * One container per sandbox, not one per `exec` call: keeps cold-
 * start out of the hot path. The container goes away in
 * `destroy()`.
 *
 * Trust model:
 *  - Container is the trust boundary; everything inside is treated
 *    as untrusted code.
 *  - Worker only listens on loopback inside its own netns; the
 *    host adapter reaches it via Docker's port-forward.
 *  - Outbound network from the worker is restricted by host-side
 *    firewall config (see {@link DockerBackendConfig.network}) plus
 *    the egress proxy when one is configured (P3.2).
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
	Sandbox,
	SandboxEnvironment,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxId,
	SandboxStatus,
} from '@namzu/sdk'

import type { SandboxBackend, SandboxBackendOptions } from '../../index.js'

/**
 * Backend-specific tuning. Most hosts use the defaults; advanced
 * deployments override `image` to point at their own pre-built
 * image, or pin `dockerBinary` for non-standard installs.
 */
export interface DockerBackendInternalConfig {
	readonly image: string
	readonly dockerBinary?: string
	readonly network?: 'none' | 'bridge' | string
	readonly readyPollIntervalMs?: number
	readonly readyTimeoutMs?: number
}

const DEFAULT_DOCKER_BINARY = 'docker'
const DEFAULT_READY_POLL_MS = 100
const DEFAULT_READY_TIMEOUT_MS = 30_000
const WORKER_PORT_INSIDE_CONTAINER = 2024

/**
 * Build a {@link SandboxBackend} backed by Docker. Construction is
 * synchronous; the actual container spawns on the first
 * `create()` call.
 */
export function buildDockerBackend(config: DockerBackendInternalConfig): SandboxBackend {
	return {
		tier: 'container',
		name: 'docker',
		async create(options) {
			return await spawnDockerSandbox(config, options)
		},
	}
}

async function spawnDockerSandbox(
	config: DockerBackendInternalConfig,
	options: SandboxBackendOptions,
): Promise<Sandbox> {
	const id = generateSandboxId()
	const docker = config.dockerBinary ?? DEFAULT_DOCKER_BINARY
	const network = config.network ?? 'none'

	const hostWorkspace = await mkdtemp(join(tmpdir(), `namzu-sandbox-${id}-`))
	await mkdir(hostWorkspace, { recursive: true })

	const hostPort = await reservePort()
	const containerName = `namzu-sandbox-${id}`

	const args: string[] = [
		'run',
		'--detach',
		'--rm',
		'--name',
		containerName,
		'--network',
		network,
		'--publish',
		`127.0.0.1:${hostPort}:${WORKER_PORT_INSIDE_CONTAINER}`,
		'--volume',
		`${hostWorkspace}:/workspace`,
	]

	if (options.memoryLimitMb && options.memoryLimitMb > 0) {
		args.push('--memory', `${options.memoryLimitMb}m`)
	}
	if (options.maxProcesses && options.maxProcesses > 0) {
		args.push('--pids-limit', String(options.maxProcesses))
	}

	for (const [key, value] of Object.entries(options.env ?? {})) {
		args.push('--env', `${key}=${value}`)
	}

	args.push(config.image)

	await runOnce(docker, args)

	let status: SandboxStatus = 'creating'

	await waitForWorkerReady(
		hostPort,
		config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		config.readyPollIntervalMs ?? DEFAULT_READY_POLL_MS,
	)

	status = 'ready'

	const baseUrl = `http://127.0.0.1:${hostPort}`

	return {
		id,
		get status(): SandboxStatus {
			return status
		},
		rootDir: '/workspace',
		environment: detectEnvironment(),

		async exec(
			command: string,
			argv?: string[],
			opts?: SandboxExecOptions,
		): Promise<SandboxExecResult> {
			status = 'busy'
			try {
				return await execViaWorker(baseUrl, command, argv, opts)
			} finally {
				status = 'ready'
			}
		},

		async writeFile(path: string, content: string | Buffer): Promise<void> {
			const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
			const res = await fetch(`${baseUrl}/write-file`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					path,
					content: buf.toString('base64'),
					encoding: 'base64',
				}),
			})
			if (!res.ok) {
				throw new Error(`write-file failed: HTTP ${res.status} ${await res.text()}`)
			}
		},

		async readFile(path: string): Promise<Buffer> {
			const res = await fetch(`${baseUrl}/read-file`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path, encoding: 'base64' }),
			})
			if (!res.ok) {
				throw new Error(`read-file failed: HTTP ${res.status} ${await res.text()}`)
			}
			const json = (await res.json()) as { ok: boolean; content?: string; error?: string }
			if (!json.ok || typeof json.content !== 'string') {
				throw new Error(json.error ?? 'read-file: no content')
			}
			return Buffer.from(json.content, 'base64')
		},

		async destroy(): Promise<void> {
			status = 'destroyed'
			await runOnceQuiet(docker, ['rm', '-f', containerName])
			await rm(hostWorkspace, { recursive: true, force: true })
		},
	}
}

async function execViaWorker(
	baseUrl: string,
	command: string,
	argv: string[] | undefined,
	opts: SandboxExecOptions | undefined,
): Promise<SandboxExecResult> {
	const start = Date.now()
	const res = await fetch(`${baseUrl}/execute`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			command,
			args: argv ?? [],
			cwd: opts?.cwd,
			env: opts?.env,
			timeoutMs: opts?.timeout,
		}),
	})
	if (!res.ok || !res.body) {
		throw new Error(`execute failed: HTTP ${res.status} ${await res.text()}`)
	}

	let stdout = ''
	let stderr = ''
	let exitCode = -1
	let timedOut = false
	let signal: string | undefined

	const decoder = new TextDecoder()
	const reader = res.body.getReader()
	let buffered = ''
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		buffered += decoder.decode(value, { stream: true })
		let newlineIdx = buffered.indexOf('\n')
		while (newlineIdx !== -1) {
			const line = buffered.slice(0, newlineIdx).trim()
			buffered = buffered.slice(newlineIdx + 1)
			if (line) {
				try {
					const event = JSON.parse(line) as
						| { type: 'stdout_delta'; data: string }
						| { type: 'stderr_delta'; data: string }
						| {
								type: 'result'
								exitCode: number
								timedOut: boolean
								durationMs: number
						  }
						| { type: 'error'; error: string }
					if (event.type === 'stdout_delta') stdout += event.data
					else if (event.type === 'stderr_delta') stderr += event.data
					else if (event.type === 'result') {
						exitCode = event.exitCode
						timedOut = event.timedOut
					} else if (event.type === 'error') {
						throw new Error(event.error)
					}
				} catch (err) {
					if (err instanceof SyntaxError) {
						// Ignore malformed lines from the worker.
					} else {
						throw err
					}
				}
			}
			newlineIdx = buffered.indexOf('\n')
		}
	}

	return {
		exitCode,
		stdout,
		stderr,
		...(signal ? { signal } : {}),
		timedOut,
		durationMs: Date.now() - start,
	}
}

function detectEnvironment(): SandboxEnvironment {
	const platform = process.platform
	if (platform === 'darwin') return 'macos-seatbelt'
	if (platform === 'linux') return 'linux-namespace'
	return 'basic'
}

function generateSandboxId(): SandboxId {
	const random = Math.random().toString(36).slice(2, 10)
	return `sandbox_${Date.now().toString(36)}_${random}` as SandboxId
}

async function reservePort(): Promise<number> {
	const { createServer } = await import('node:net')
	return await new Promise<number>((resolve, reject) => {
		const server = createServer()
		server.unref()
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (!address || typeof address === 'string') {
				server.close()
				reject(new Error('failed to reserve port'))
				return
			}
			const port = address.port
			server.close(() => resolve(port))
		})
	})
}

async function waitForWorkerReady(port: number, timeoutMs: number, pollMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/healthz`)
			if (res.ok) return
			lastError = new Error(`healthz HTTP ${res.status}`)
		} catch (err) {
			lastError = err
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
	throw new Error(
		`namzu-sandbox worker did not become ready within ${timeoutMs}ms: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	)
}

function runOnce(binary: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8')
		})
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8')
		})
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) resolve(stdout.trim())
			else reject(new Error(`${binary} ${args.join(' ')} exited ${code}: ${stderr.trim()}`))
		})
	})
}

function runOnceQuiet(binary: string, args: string[]): Promise<void> {
	return new Promise((resolve) => {
		const child = spawn(binary, args, { stdio: 'ignore' })
		child.on('error', () => resolve())
		child.on('close', () => resolve())
	})
}

// `mkdir`, `mkdtemp`, `rm`, `readFile`, `writeFile`, `tmpdir` are
// imported above for completeness even though `readFile` /
// `writeFile` aren't used in this trimmed first-cut — leaving the
// import wire ready for the egress-proxy bind-mount work in P3.2
// (it will write a small `egress-config.json` into the workspace
// the worker reads at startup).
void readFile
void writeFile

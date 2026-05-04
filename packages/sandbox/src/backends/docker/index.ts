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
	/**
	 * Path inside the container that the host workspace bind-mounts
	 * onto. Defaults to `/workspace` to match the worker image; hosts
	 * that need a different convention (e.g. Vandal mirrors Anthropic
	 * Managed Agents' `/mnt/session` so model training-time intuition
	 * about where to write deliverables matches the local runtime
	 * without prompt-side steering) override this. The same path is
	 * forwarded to the in-container worker via the
	 * `NAMZU_SANDBOX_WORKSPACE` env var so the worker's own resolver
	 * agrees with the bind mount.
	 */
	readonly workspaceMount?: string
	/**
	 * Docker runtime to launch the container under. Default `runc`
	 * (vanilla Docker namespaces, what Docker Desktop ships). Linux
	 * production deployments that have registered gVisor on the host
	 * daemon can pass `runsc` to upgrade to a userspace-kernel trust
	 * boundary — same primitive Modal Labs and OpenAI Code Interpreter
	 * ship. Hosts can also pass a custom runtime name registered in
	 * `daemon.json`. macOS Docker Desktop has no `runsc` runtime, so
	 * the default `runc` is the only option there; that's documented
	 * as the local-dev tier in the package README.
	 */
	readonly runtime?: 'runc' | 'runsc' | string
	/**
	 * How the SDK consumer reaches the in-container worker:
	 *
	 *  - `'host-port'` (default): publish the worker port on the
	 *    host loopback (`127.0.0.1::<random>`) and connect by host
	 *    port. Works when the SDK runs ON the docker host (CLI,
	 *    direct dev). Backward-compatible — the original behaviour.
	 *
	 *  - `'container-network'`: skip `--publish` entirely, attach
	 *    the spawned container to a shared docker bridge that the
	 *    SDK consumer is also on, and connect by container DNS name
	 *    (`http://<containerName>:2024`). Required when the SDK
	 *    runs INSIDE a container (e.g. Vandal's app container
	 *    spawning sibling sandbox containers via the host's Docker
	 *    daemon — `127.0.0.1` inside the app is the app, not the
	 *    sandbox). The shared bridge name comes from `config.network`.
	 */
	readonly hostReachability?: 'host-port' | 'container-network'
}

const DEFAULT_DOCKER_BINARY = 'docker'
const DEFAULT_READY_POLL_MS = 100
const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_WORKSPACE_MOUNT = '/workspace'
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
	const workspaceMount = config.workspaceMount ?? DEFAULT_WORKSPACE_MOUNT
	const runtime = config.runtime
	const hostReachability = config.hostReachability ?? 'host-port'
	const containerName = `namzu-sandbox-${id}`

	// Track resources so any failure path can clean them up. Codex
	// stop-time review caught that the original create path leaked
	// `hostWorkspace` and possibly a running container if `docker
	// run` succeeded but `/healthz` polling timed out.
	let hostWorkspace: string | undefined
	let containerStarted = false
	// Host-managed bind sources (provided by the SDK consumer) are
	// NOT cleaned up on failure — the consumer's lifecycle owns the
	// directory. Only auto-allocated tmpdir workspaces get rm'd.
	const hostManagedBind = options.hostWorkspaceDir !== undefined

	async function cleanupOnFailure() {
		if (containerStarted) {
			await runOnceQuiet(docker, ['rm', '-f', containerName])
		}
		if (hostWorkspace && !hostManagedBind) {
			await rm(hostWorkspace, { recursive: true, force: true })
		}
	}

	let hostPort: number
	let baseUrl: string

	try {
		// Two paths for the host-side workspace bind source:
		//   1. SDK consumer supplies an explicit `hostWorkspaceDir`
		//      (e.g. Vandal's per-task `/var/lib/vandal/sessions/<taskId>`).
		//      The consumer owns the dir lifecycle — backend doesn't
		//      mkdir/rm it.
		//   2. No path supplied → mkdtemp under the OS tmpdir; backend
		//      cleans it up on failure or on `destroy()`.
		// Path #1 is required when the consumer is itself a container
		// asking the host's Docker daemon to spawn a sibling: the
		// daemon resolves bind sources against the host filesystem,
		// not the consumer container's filesystem, so a dir under
		// `tmpdir()` of the consumer container is unreachable. Codex
		// flagged this as the named-volume-sub-path blocker.
		if (options.hostWorkspaceDir) {
			hostWorkspace = options.hostWorkspaceDir
			await mkdir(hostWorkspace, { recursive: true })
		} else {
			hostWorkspace = await mkdtemp(join(tmpdir(), `namzu-sandbox-${id}-`))
			await mkdir(hostWorkspace, { recursive: true })
		}

		// Let Docker pick the host port instead of pre-reserving one
		// in this process. The reservePort()-then-publish-fixed-port
		// pattern had a TOCTOU window: the OS could hand the port to
		// another process between our `server.close()` and Docker's
		// `bind()`. Letting Docker pick (`--publish-all`) and reading
		// the mapping back via `docker inspect` removes the race.
		const args: string[] = [
			'run',
			'--detach',
			'--rm',
			'--name',
			containerName,
			'--network',
			network,
			'--volume',
			`${hostWorkspace}:${workspaceMount}`,
			// Forward the in-container workspace path to the worker so
			// its own resolver agrees with the bind mount when the host
			// overrides the default `/workspace`.
			'--env',
			`NAMZU_SANDBOX_WORKSPACE=${workspaceMount}`,
		]

		// Only publish a host port when the consumer is going to reach
		// the worker through the docker host's loopback (CLI / direct
		// dev). For `container-network` reachability we leave the port
		// unpublished — sibling containers reach the worker by its DNS
		// name on the shared bridge, no host port required.
		if (hostReachability === 'host-port') {
			args.push('--publish', `127.0.0.1::${WORKER_PORT_INSIDE_CONTAINER}`)
		}

		if (runtime) {
			args.push('--runtime', runtime)
		}

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
		containerStarted = true

		if (hostReachability === 'host-port') {
			hostPort = await readMappedPort(docker, containerName)
			baseUrl = `http://127.0.0.1:${hostPort}`
			await waitForWorkerReady(
				baseUrl,
				config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
				config.readyPollIntervalMs ?? DEFAULT_READY_POLL_MS,
			)
		} else {
			// container-network: connect by container DNS name on the
			// shared bridge. No host port to read; the SDK consumer is
			// itself a container on the same bridge.
			baseUrl = `http://${containerName}:${WORKER_PORT_INSIDE_CONTAINER}`
			await waitForWorkerReady(
				baseUrl,
				config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
				config.readyPollIntervalMs ?? DEFAULT_READY_POLL_MS,
			)
		}
	} catch (err) {
		await cleanupOnFailure()
		throw err
	}

	let status: SandboxStatus = 'ready'

	return {
		id,
		get status(): SandboxStatus {
			return status
		},
		rootDir: workspaceMount,
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
			if (hostWorkspace) {
				await rm(hostWorkspace, { recursive: true, force: true })
			}
		},
	}
}

/**
 * Ask Docker which host port it bound to the worker port. Used
 * instead of the pre-reserve-then-publish pattern (which had a
 * TOCTOU race window between this process closing the listening
 * socket and Docker's bind picking the same port — another
 * process could grab it in the meantime). Letting Docker
 * allocate and reading the mapping back is race-free.
 */
async function readMappedPort(docker: string, containerName: string): Promise<number> {
	const inspectOutput = await runOnce(docker, [
		'inspect',
		'--format',
		`{{(index (index .NetworkSettings.Ports "${WORKER_PORT_INSIDE_CONTAINER}/tcp") 0).HostPort}}`,
		containerName,
	])
	const port = Number(inspectOutput.trim())
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(
			`docker inspect returned no usable host port mapping for ${containerName}: '${inspectOutput}'`,
		)
	}
	return port
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

async function waitForWorkerReady(
	baseUrl: string,
	timeoutMs: number,
	pollMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/healthz`)
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

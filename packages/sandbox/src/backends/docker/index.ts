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

import {
	type ContainerSandboxLayout,
	type ContainerSandboxLayoutMount,
	type ResolvedContainerSandboxLayout,
	SANDBOX_DEFAULT_OUTPUTS_PATH,
	SANDBOX_DEFAULT_SCRATCH_PATH,
	SANDBOX_DEFAULT_SKILLS_PARENT,
	SANDBOX_DEFAULT_TOOL_RESULTS_PATH,
	SANDBOX_DEFAULT_TRANSCRIPTS_PATH,
	SANDBOX_DEFAULT_UPLOADS_PATH,
	type Sandbox,
	type SandboxEnvironment,
	type SandboxExecOptions,
	type SandboxExecResult,
	type SandboxId,
	type SandboxStatus,
} from '@namzu/sdk'

import {
	ContainerSandboxLayoutValidationError,
	type SandboxBackend,
	type SandboxBackendOptions,
} from '../../index.js'

/**
 * Backend-specific tuning. Most hosts use the defaults; advanced
 * deployments override `image` to point at their own pre-built
 * image, or pin `dockerBinary` for non-standard installs.
 *
 * The container's mount layout is baked in at provider construction
 * via {@link DockerBackendInternalConfig.layout} — every `create()`
 * call inherits the same layout. This is by design: per-task hosts
 * call `createSandboxProvider` once per task, with that task's
 * layout. There is no per-call layout argument, so the SDK runtime
 * cannot accidentally call a docker provider without one.
 */
export interface DockerBackendInternalConfig {
	readonly image: string
	/**
	 * Pre-resolved layout. Construction-time `resolveLayout` validates
	 * and applies defaults; the docker backend renders mount flags
	 * directly from this without re-validating.
	 */
	readonly layout: ResolvedContainerSandboxLayout
	readonly dockerBinary?: string
	readonly network?: 'none' | 'bridge' | string
	readonly readyPollIntervalMs?: number
	readonly readyTimeoutMs?: number
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
	/**
	 * Optional `--label key=value` pairs applied to the spawned
	 * container at `docker run` time. Used by hosts that need to
	 * find their containers from out-of-band code paths (reaper jobs,
	 * monitoring filters) via `docker ps --filter label=…`. Keys
	 * containing `=` or empty names throw at spawn time — the docker
	 * CLI accepts them but the resulting label split is ambiguous.
	 */
	readonly labels?: Readonly<Record<string, string>>
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
		async create(options: SandboxBackendOptions) {
			return await spawnDockerSandbox(config, options)
		},
	}
}

async function spawnDockerSandbox(
	config: DockerBackendInternalConfig,
	options: SandboxBackendOptions,
): Promise<Sandbox> {
	const resolvedLayout = config.layout
	const id = generateSandboxId()
	const docker = config.dockerBinary ?? DEFAULT_DOCKER_BINARY
	const network = config.network ?? 'none'
	const runtime = config.runtime
	const hostReachability = config.hostReachability ?? 'host-port'
	const containerName = `namzu-sandbox-${id}`

	// All bind sources come from the consumer-supplied layout. The
	// backend never allocates host directories and never removes them
	// — that pre-existing single-mount mkdtemp path was the source of
	// the EACCES bug in sibling-container setups (the consumer owns
	// the host filesystem, the spawned backend can't reach it from
	// inside its own container's mount namespace). Clean break.
	let containerStarted = false

	async function cleanupOnFailure() {
		if (containerStarted) {
			await runOnceQuiet(docker, ['rm', '-f', containerName])
		}
	}

	let hostPort: number
	let baseUrl: string
	// `outputs` is required by validation, so its containerPath is
	// always available — the worker uses it as its workspace root.
	const rootDir = resolvedLayout.outputs.containerPath

	try {
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
		]

		// `--label key=value` flags. Validate first — an empty key or
		// a key containing `=` would silently produce a malformed
		// label that downstream `docker ps --filter label=…` queries
		// could not match reliably. Throw before the spawn so misuse
		// surfaces during construction, not as a mysterious "container
		// has no labels" later.
		if (config.labels) {
			for (const [key, value] of Object.entries(config.labels)) {
				if (!key || key.includes('=')) {
					throw new Error(
						`docker label key ${JSON.stringify(key)} is invalid (empty or contains '=')`,
					)
				}
				args.push('--label', `${key}=${value}`)
			}
		}

		args.push(...renderLayoutMountArgs(resolvedLayout))
		// Forward only the workspace root so the worker's lexical
		// resolver agrees with the bind target. The full layout used
		// to ride along as `NAMZU_SANDBOX_LAYOUT`, but the worker
		// never branched on it; the manifest's only consumer was a
		// log line. A skill loader that needs the manifest will
		// write it to a bind path the worker reads at startup —
		// avoids env-size limits, keeps the wire shape minimal.
		args.push('--env', `NAMZU_SANDBOX_WORKSPACE=${rootDir}`)
		args.push('--env', `NAMZU_SANDBOX_READ_ROOTS=${renderLayoutReadRootsEnv(resolvedLayout)}`)
		args.push('--env', `NAMZU_SANDBOX_WRITE_ROOTS=${renderLayoutWriteRootsEnv(resolvedLayout)}`)

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
		rootDir,
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
			let res: Response
			try {
				res = await fetch(`${baseUrl}/write-file`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						path,
						content: buf.toString('base64'),
						encoding: 'base64',
					}),
				})
			} catch (err) {
				const cause = err instanceof Error ? err.cause : undefined
				const causeMsg =
					cause instanceof Error
						? `${cause.message}${(cause as Error & { code?: string }).code ? ` (${(cause as Error & { code?: string }).code})` : ''}`
						: cause
							? String(cause)
							: 'unknown'
				throw new Error(
					`namzu-sandbox /write-file fetch failed (baseUrl=${baseUrl}, path=${path}): ${err instanceof Error ? err.message : String(err)} — cause: ${causeMsg}`,
					{ cause: err },
				)
			}
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
			// Backend never allocates host paths — every bind source
			// comes from the consumer-supplied layout. Container
			// teardown is sufficient; the consumer's own lifecycle
			// owns each `hostPath`.
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
	let res: Response
	try {
		res = await fetch(`${baseUrl}/execute`, {
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
	} catch (err) {
		// Surface the underlying transport error (DNS, ECONNREFUSED,
		// socket-hangup, …) instead of the generic "fetch failed" the
		// undici client throws. Without `cause`, ops cannot tell whether
		// the worker died, the bridge dropped, or something else.
		const cause = err instanceof Error ? err.cause : undefined
		const causeMsg =
			cause instanceof Error
				? `${cause.message}${(cause as Error & { code?: string }).code ? ` (${(cause as Error & { code?: string }).code})` : ''}`
				: cause
					? String(cause)
					: 'unknown'
		throw new Error(
			`namzu-sandbox /execute fetch failed (baseUrl=${baseUrl}): ${err instanceof Error ? err.message : String(err)} — cause: ${causeMsg}`,
			{ cause: err },
		)
	}
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

/**
 * Skill IDs are user-controlled strings that end up in the in-
 * container path (`/mnt/skills/<id>`) and on a `--volume` flag the
 * shell does not see (we use `spawn` argv, not a shell pipeline). So
 * the regex doesn't have to defend against shell metacharacters — it
 * exists to keep paths legible (no whitespace, no `..`, no slashes
 * to escape the `/mnt/skills` prefix). The set is the same shape git
 * accepts for ref names: alphanumerics, `_`, `-`, `.`. Letting `.`
 * through enables `pdf-tools.v2`-style versioning; rejecting `..`
 * specifically guards path traversal even though Docker's bind
 * resolution doesn't follow it.
 */
const SKILL_ID_REGEX = /^[a-zA-Z0-9_.-]+$/

/**
 * Validate and resolve a {@link ContainerSandboxLayout}. Returns a
 * {@link ResolvedContainerSandboxLayout} with every container path
 * filled in; throws {@link ContainerSandboxLayoutValidationError}
 * collecting every violation in one pass.
 *
 * Called once at provider construction (`createSandboxProvider`).
 * Validation surfaces synchronously during host wiring; nothing
 * downstream re-validates per `provider.create()` call.
 *
 * Exported for tests so the validation rules are pinned by golden-
 * value assertions rather than only exercised through the spawn path.
 */
export function resolveLayout(layout: ContainerSandboxLayout): ResolvedContainerSandboxLayout {
	const reasons: string[] = []

	// Outputs is required — without it the model has no place to
	// persist work past container teardown, and the worker has no
	// rooted workspace for its path resolver. The SDK type marks
	// outputs required too, but the public type can be circumvented
	// with `as` casts; runtime check is the contract.
	if (!layout.outputs) {
		reasons.push(
			'`outputs` is required (deliverables surface). Pass `layout.outputs.source = { type: "hostDir", hostPath: "..." }`.',
		)
	}

	// Skill IDs: regex + substring `..` reject + duplicate check.
	// Run even if `outputs` is missing so the consumer sees every
	// problem in one pass — fix-then-rerun loops at this layer are
	// cheap to avoid.
	//
	// Why the substring `..` reject on top of the regex: the regex
	// `[a-zA-Z0-9_.-]` legitimately allows `.` (so ids like
	// `pdf-tools.v2` work), but `..` (or any embedded `..` like
	// `foo..bar`) is a path-traversal segment that, when
	// interpolated into the default container path
	// `/mnt/skills/<id>`, lifts the bind out of the skills parent.
	// Reject any `..` substring outright — there is no legitimate
	// skill-id shape with consecutive dots.
	const skillIds = new Set<string>()
	if (layout.skills) {
		for (const skill of layout.skills) {
			if (!SKILL_ID_REGEX.test(skill.id)) {
				reasons.push(
					`skill id ${JSON.stringify(skill.id)} contains characters outside [a-zA-Z0-9_.-]`,
				)
			} else if (skill.id.includes('..')) {
				reasons.push(
					`skill id ${JSON.stringify(skill.id)} contains a path-traversal segment ('..')`,
				)
			} else if (skillIds.has(skill.id)) {
				reasons.push(`duplicate skill id ${JSON.stringify(skill.id)}`)
			} else {
				skillIds.add(skill.id)
			}
		}
	}

	// Resolve container paths now (before duplicate check) so
	// duplicate detection sees the actual mount targets, including
	// defaults applied when `containerPath` is omitted. Defaults
	// come from `@namzu/sdk`'s exported constants so a Vandal prompt
	// template generator and the backend agree on a single source of
	// truth.
	const resolvedOutputs = layout.outputs
		? {
				source: layout.outputs.source,
				containerPath: layout.outputs.containerPath ?? SANDBOX_DEFAULT_OUTPUTS_PATH,
			}
		: undefined
	const resolvedUploads = layout.uploads
		? {
				source: layout.uploads.source,
				containerPath: layout.uploads.containerPath ?? SANDBOX_DEFAULT_UPLOADS_PATH,
			}
		: undefined
	const resolvedScratch = layout.scratch
		? {
				source: layout.scratch.source,
				containerPath: layout.scratch.containerPath ?? SANDBOX_DEFAULT_SCRATCH_PATH,
			}
		: undefined
	const resolvedToolResults = layout.toolResults
		? {
				source: layout.toolResults.source,
				containerPath: layout.toolResults.containerPath ?? SANDBOX_DEFAULT_TOOL_RESULTS_PATH,
			}
		: undefined
	const resolvedTranscripts = layout.transcripts
		? {
				source: layout.transcripts.source,
				containerPath: layout.transcripts.containerPath ?? SANDBOX_DEFAULT_TRANSCRIPTS_PATH,
			}
		: undefined
	const resolvedSkills = layout.skills?.map((s) => ({
		id: s.id,
		source: s.source,
		containerPath: s.containerPath ?? `${SANDBOX_DEFAULT_SKILLS_PARENT}/${s.id}`,
	}))

	// Duplicate `containerPath` detection across every mount. Two
	// binds at the same path is a Docker error at the daemon level,
	// but the daemon's error surfaces inside the container creation
	// failure mode — much later, with less context. Catch it here.
	const containerPathOwners = new Map<string, string>()
	function track(label: string, p: string | undefined) {
		if (!p) return
		const prior = containerPathOwners.get(p)
		if (prior) {
			reasons.push(
				`duplicate containerPath ${JSON.stringify(p)} declared by both ${prior} and ${label}`,
			)
		} else {
			containerPathOwners.set(p, label)
		}
	}
	track('outputs', resolvedOutputs?.containerPath)
	track('uploads', resolvedUploads?.containerPath)
	track('scratch', resolvedScratch?.containerPath)
	track('toolResults', resolvedToolResults?.containerPath)
	track('transcripts', resolvedTranscripts?.containerPath)
	if (resolvedSkills) {
		for (const skill of resolvedSkills) {
			track(`skill:${skill.id}`, skill.containerPath)
		}
	}

	if (reasons.length > 0) {
		throw new ContainerSandboxLayoutValidationError(reasons)
	}

	// `outputs` presence was checked above; the non-null assertion is
	// safe because the validation throws on missing.
	const resolved: ResolvedContainerSandboxLayout = {
		// biome-ignore lint/style/noNonNullAssertion: validation enforces presence
		outputs: resolvedOutputs!,
		...(resolvedUploads ? { uploads: resolvedUploads } : {}),
		...(resolvedScratch ? { scratch: resolvedScratch } : {}),
		...(resolvedToolResults ? { toolResults: resolvedToolResults } : {}),
		...(resolvedTranscripts ? { transcripts: resolvedTranscripts } : {}),
		...(resolvedSkills && resolvedSkills.length > 0 ? { skills: resolvedSkills } : {}),
	}
	return resolved
}

/**
 * Render `--volume` flags for a {@link ResolvedContainerSandboxLayout}. Order
 * is stable (outputs rw, uploads ro, toolResults ro, skills ro,
 * transcripts ro) so the test golden values stay deterministic.
 *
 * Today every `ContainerSandboxMountSource` is `{ type: 'hostDir', hostPath }`.
 * When future variants land (squashfs / managed volumes), this
 * function gains a discriminator switch; the single-variant union
 * keeps tomorrow's exhaustiveness check honest by giving us a
 * `type` field to switch on without renaming the call sites.
 */
/**
 * Narrow a {@link ContainerSandboxMountSource} to the `hostDir`
 * variant for backends that only know how to bind-mount from a host
 * filesystem path (docker, podman, plain Firecracker virtio-fs). Any
 * other variant (e.g. `azureFileShare` consumed by the ACI backend)
 * is a hard configuration mismatch — throw at spawn time rather than
 * render a malformed `--volume` flag the daemon would reject with a
 * confusing message.
 */
function requireHostDir(
	source: ContainerSandboxLayoutMount['source'],
	label: string,
): { readonly hostPath: string } {
	if (source.type !== 'hostDir') {
		throw new Error(
			`docker backend cannot consume mount source type ${JSON.stringify(source.type)} for ${label}; ` +
				`expected 'hostDir'. The non-hostDir variants (e.g. 'azureFileShare') belong to managed-container backends.`,
		)
	}
	return source
}

export function renderLayoutMountArgs(layout: ResolvedContainerSandboxLayout): string[] {
	const args: string[] = []
	const outputs = requireHostDir(layout.outputs.source, 'outputs')
	args.push('--volume', `${outputs.hostPath}:${layout.outputs.containerPath}:rw`)
	if (layout.uploads) {
		const uploads = requireHostDir(layout.uploads.source, 'uploads')
		args.push('--volume', `${uploads.hostPath}:${layout.uploads.containerPath}:ro`)
	}
	if (layout.scratch) {
		// Scratch is RW so the agent can read its own intermediate
		// drafts back. It is NOT visible to the deliverables collector
		// because the host directory it binds is a sibling of, not a
		// child of, the outputs hostPath.
		const scratch = requireHostDir(layout.scratch.source, 'scratch')
		args.push('--volume', `${scratch.hostPath}:${layout.scratch.containerPath}:rw`)
	}
	if (layout.toolResults) {
		const toolResults = requireHostDir(layout.toolResults.source, 'toolResults')
		args.push('--volume', `${toolResults.hostPath}:${layout.toolResults.containerPath}:ro`)
	}
	if (layout.skills) {
		for (const skill of layout.skills) {
			const skillSrc = requireHostDir(skill.source, `skill ${skill.id}`)
			args.push('--volume', `${skillSrc.hostPath}:${skill.containerPath}:ro`)
		}
	}
	if (layout.transcripts) {
		const transcripts = requireHostDir(layout.transcripts.source, 'transcripts')
		args.push('--volume', `${transcripts.hostPath}:${layout.transcripts.containerPath}:ro`)
	}
	return args
}

export function renderLayoutReadRootsEnv(layout: ResolvedContainerSandboxLayout): string {
	const roots = [
		layout.outputs.containerPath,
		layout.uploads?.containerPath,
		layout.scratch?.containerPath,
		layout.toolResults?.containerPath,
		layout.transcripts?.containerPath,
		...(layout.skills?.map((skill) => skill.containerPath) ?? []),
	].filter((root): root is string => Boolean(root))
	return Array.from(new Set(roots)).join(':')
}

/**
 * Writable container roots. Only the RW mounts go here — uploads,
 * tool-results, transcripts, and skills are read-only and must stay
 * out of WRITE_ROOTS or the agent's `write`/`append` could clobber
 * source files the host considers immutable.
 */
export function renderLayoutWriteRootsEnv(layout: ResolvedContainerSandboxLayout): string {
	const roots = [
		layout.outputs.containerPath,
		layout.scratch?.containerPath,
	].filter((root): root is string => Boolean(root))
	return Array.from(new Set(roots)).join(':')
}

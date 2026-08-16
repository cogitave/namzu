import { execSync, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import {
	readFile as fsReadFile,
	writeFile as fsWriteFile,
	mkdir,
	readdir,
	rename,
	rm,
	stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
	SANDBOX_DEFAULT_TIMEOUT_MS,
	SANDBOX_KILL_GRACE_MS,
	SANDBOX_MAX_OUTPUT_BYTES,
	SANDBOX_SAFE_ENV_KEYS,
	SANDBOX_TEMP_DIR_PREFIX,
} from '../../constants/sandbox/index.js'
// The process-tree kill lives in its own leaf now: the background job
// registry needs the same one, and a near-copy would reproduce in the copy
// every bug the original's comment was written to record.
import { killTree } from '../../process/kill-tree.js'
import type { SandboxId } from '../../types/ids/index.js'
import type {
	Sandbox,
	SandboxCreateConfig,
	SandboxEnvironment,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxFileEntry,
	SandboxIsolationControl,
	SandboxProvider,
	SandboxStatus,
} from '../../types/sandbox/index.js'
import { generateSandboxId } from '../../utils/id.js'
import type { Logger } from '../../utils/logger.js'
import { assertIsolation, describeIsolation } from '../isolation.js'
import {
	type OpenTerminalOptions,
	type PtyLoader,
	type TerminalSession,
	loadPty,
	openTerminalWith,
} from '../terminal.js'

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function assertInsideSandbox(sandboxRoot: string, targetPath: string): string {
	const resolved = resolve(sandboxRoot, targetPath)
	const rel = relative(sandboxRoot, resolved)
	if (rel.startsWith('..') || isAbsolute(rel)) {
		throw new Error(`Path escapes sandbox: ${targetPath}`)
	}
	return resolved
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/**
 * Flags the Linux tier spawns under. Kept next to the probe so detection
 * tests the isolation that will actually be applied, not a weaker subset.
 */
const LINUX_UNSHARE_FLAGS = ['--mount', '--pid', '--fork', '--map-root-user', '--net']

/**
 * One output stream, accumulated under a byte cap that it reports hitting.
 *
 * The clipping was inline and the flag was not set, so a run whose output
 * ran past the cap returned a result that looked whole. The tool layer
 * already renders `stdoutTruncated` when a backend sets it — this one
 * simply never did, which is the silent truncation the contract's own doc
 * says the kernel does not do.
 */
export class CappedStream {
	private chunks = ''
	private bytes = 0

	constructor(private readonly capBytes: number) {}

	push(chunk: Buffer): void {
		if (this.bytes < this.capBytes) {
			this.chunks += chunk.subarray(0, this.capBytes - this.bytes).toString('utf-8')
		}
		this.bytes += chunk.length
	}

	get text(): string {
		return this.chunks
	}

	/** True once more arrived than was kept. */
	get truncated(): boolean {
		return this.bytes > this.capBytes
	}
}

export interface LimitedSpawnRequest {
	readonly environment: SandboxEnvironment
	readonly command: string
	readonly args: readonly string[]
	readonly rootDir: string
	readonly memoryLimitMb?: number
	readonly maxProcesses?: number
}

/** Single-quote for a shell, escaping any quote already inside. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * How one command is spawned under a tier, with the resource caps applied.
 *
 * The caps used to live inside the unconfined tier's branch only, so a host
 * that asked for stronger isolation had its memory and process limits
 * silently dropped — a control failing in the one direction nobody checks.
 * They are the same shell builtin on every tier; the only difference is
 * that the stronger tiers apply them one level in, inside the wrapper they
 * already spawn through.
 */
export function buildLimitedSpawn(request: LimitedSpawnRequest): {
	spawnCommand: string
	spawnArgs: string[]
} {
	const { environment, command, args, rootDir } = request

	const limits: string[] = []
	if (request.memoryLimitMb !== undefined) {
		limits.push(`ulimit -v ${request.memoryLimitMb * 1024}`)
	}
	if (request.maxProcesses !== undefined) {
		limits.push(`ulimit -u ${request.maxProcesses}`)
	}

	// The innermost command: either the target itself, or the target behind
	// a shell that sets the caps first.
	const inner: readonly string[] =
		limits.length > 0
			? [
					'/bin/sh',
					'-c',
					`${limits.join(' && ')} && ${[command, ...args].map(shellQuote).join(' ')}`,
				]
			: [command, ...args]

	switch (environment) {
		case 'linux-namespace':
			return {
				spawnCommand: 'unshare',
				spawnArgs: [...LINUX_UNSHARE_FLAGS, '--', ...inner],
			}

		case 'macos-seatbelt':
			return {
				spawnCommand: 'sandbox-exec',
				spawnArgs: ['-p', buildSeatbeltProfile(rootDir), '--', ...inner],
			}

		case 'basic': {
			const [head, ...rest] = inner
			return { spawnCommand: head as string, spawnArgs: rest }
		}

		default: {
			const _exhaustive: never = environment
			throw new Error(`Unknown sandbox environment: ${_exhaustive}`)
		}
	}
}

function detectEnvironment(): SandboxEnvironment {
	const { platform } = process

	if (platform === 'linux') {
		try {
			// Probe the real flags, not just the binary. `unshare --version`
			// succeeds on a host where unprivileged user namespaces are
			// disabled by sysctl and every actual spawn would fail — the tier
			// would be claimed and never delivered. The other platform's probe
			// already runs its sandbox for real; this one now does too.
			execSync(`unshare ${LINUX_UNSHARE_FLAGS.join(' ')} -- /bin/true`, {
				stdio: 'ignore',
			})
			return 'linux-namespace'
		} catch {
			// unshare missing, or the host refuses the namespaces we need
		}
	}

	if (platform === 'darwin') {
		try {
			execSync('sandbox-exec -n no-network /usr/bin/true', { stdio: 'ignore' })
			return 'macos-seatbelt'
		} catch {
			// sandbox-exec not available
		}
	}

	return 'basic'
}

// ---------------------------------------------------------------------------
// Seatbelt profile
// ---------------------------------------------------------------------------

/**
 * Resolve a path to its canonical form so seatbelt matches correctly.
 * macOS symlinks like /var → /private/var must be resolved before use
 * in SBPL rules, because the kernel evaluates real paths.
 */
function canonicalizePath(p: string): string {
	try {
		return realpathSync(p)
	} catch {
		// Path may not exist yet — resolve manually for known macOS symlinks
		if (p.startsWith('/var/')) return `/private${p}`
		if (p.startsWith('/tmp/')) return `/private${p}`
		return p
	}
}

/**
 * Build a macOS seatbelt (SBPL) profile for sandbox isolation.
 *
 * Key principle: (deny default) + explicit allows. Network always denied.
 */
function buildSeatbeltProfile(sandboxRoot: string): string {
	const root = canonicalizePath(sandboxRoot)

	return [
		'(version 1)',
		'(deny default)',

		// --- Process lifecycle ---
		'(allow process-exec)',
		'(allow process-fork)',
		'(allow process-info* (target same-sandbox))',
		'(allow signal (target same-sandbox))',

		// --- Sandbox workspace — full read/write ---
		`(allow file-read* (subpath "${root}"))`,
		`(allow file-write* (subpath "${root}"))`,

		// --- Root path literal — dyld needs this for path resolution ---
		'(allow file-read* (literal "/"))',

		// --- System binaries and libraries (read-only) ---
		'(allow file-read* (subpath "/usr/lib"))',
		'(allow file-read* (subpath "/usr/bin"))',
		'(allow file-read* (subpath "/bin"))',
		'(allow file-read* (subpath "/sbin"))',
		'(allow file-read* (subpath "/usr/sbin"))',
		'(allow file-read* (subpath "/usr/share"))',
		'(allow file-read* (subpath "/usr/local"))',

		// --- macOS system frameworks and dyld shared cache ---
		'(allow file-read* (subpath "/System"))',
		'(allow file-read* (subpath "/Library/Frameworks"))',
		'(allow file-read* (subpath "/private/var/db/dyld"))',
		'(allow file-read* (subpath "/private/var/select"))',

		// --- Device files ---
		'(allow file-read* (subpath "/dev"))',
		'(allow file-write* (literal "/dev/null"))',
		'(allow file-ioctl (literal "/dev/null"))',
		'(allow file-ioctl (literal "/dev/zero"))',
		'(allow file-ioctl (literal "/dev/random"))',
		'(allow file-ioctl (literal "/dev/urandom"))',
		'(allow file-ioctl (literal "/dev/tty"))',

		// --- Temp directories (canonical paths) ---
		'(allow file-read* (subpath "/private/tmp"))',
		'(allow file-read* (subpath "/private/var/tmp"))',
		'(allow file-write* (subpath "/private/tmp"))',
		'(allow file-write* (subpath "/private/var/tmp"))',

		// --- File metadata — needed for realpath() traversal ---
		'(allow file-read-metadata)',

		// --- System info ---
		'(allow sysctl-read)',
		'(allow user-preference-read)',

		// --- Mach IPC — essential services only ---
		'(allow mach-lookup',
		'  (global-name "com.apple.logd")',
		'  (global-name "com.apple.system.logger")',
		'  (global-name "com.apple.system.notification_center")',
		'  (global-name "com.apple.system.opendirectoryd.libinfo")',
		'  (global-name "com.apple.system.opendirectoryd.membership")',
		'  (global-name "com.apple.bsd.dirhelper")',
		'  (global-name "com.apple.SecurityServer")',
		'  (global-name "com.apple.securityd.xpc")',
		'  (global-name "com.apple.coreservices.launchservicesd")',
		'  (global-name "com.apple.fonts")',
		'  (global-name "com.apple.FontObjectsServer")',
		'  (global-name "com.apple.lsd.mapdb")',
		')',

		// --- POSIX IPC ---
		'(allow ipc-posix-shm)',
		'(allow ipc-posix-sem)',

		// --- Network — deny all ---
		'(deny network*)',
	].join('\n')
}

// ---------------------------------------------------------------------------
// Environment building
// ---------------------------------------------------------------------------

function buildSafeEnv(
	configEnv?: Record<string, string>,
	optsEnv?: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = {}

	for (const key of SANDBOX_SAFE_ENV_KEYS) {
		const value = process.env[key]
		if (value !== undefined) {
			env[key] = value
		}
	}

	if (configEnv) {
		Object.assign(env, configEnv)
	}
	if (optsEnv) {
		Object.assign(env, optsEnv)
	}

	return env
}

// ---------------------------------------------------------------------------
// LocalSandbox
// ---------------------------------------------------------------------------

class LocalSandbox implements Sandbox {
	readonly id: SandboxId
	readonly rootDir: string
	readonly environment: SandboxEnvironment

	private _status: SandboxStatus
	private readonly config: SandboxCreateConfig
	private readonly log: Logger

	get status(): SandboxStatus {
		return this._status
	}

	/**
	 * How the pty binding is loaded. Injectable so a test needs no native
	 * build — the refusal path and the session wiring are both worth
	 * covering, and neither should require compiling C++ on CI.
	 */
	private readonly ptyLoader: PtyLoader | undefined

	constructor(
		id: SandboxId,
		rootDir: string,
		environment: SandboxEnvironment,
		config: SandboxCreateConfig,
		log: Logger,
		ptyLoader?: PtyLoader,
	) {
		this.ptyLoader = ptyLoader
		this.id = id
		this.rootDir = rootDir
		this.environment = environment
		this.config = config
		this._status = 'ready'
		this.log = log.child({ component: 'LocalSandbox', sandboxId: id })

		this.log.info('Sandbox created', {
			'namzu.sandbox.root_dir': rootDir,
			'namzu.execution.environment': environment,
		})
	}

	async exec(
		command: string,
		args: string[] = [],
		opts?: SandboxExecOptions,
	): Promise<SandboxExecResult> {
		if (this._status === 'destroyed') {
			throw new Error(`Sandbox ${this.id} is destroyed`)
		}

		this._status = 'busy'
		const startTime = Date.now()

		const env = buildSafeEnv(this.config.env, opts?.env)
		const timeout = opts?.timeout ?? this.config.timeoutMs ?? SANDBOX_DEFAULT_TIMEOUT_MS

		const cwd = opts?.cwd ? assertInsideSandbox(this.rootDir, opts.cwd) : this.rootDir

		const { spawnCommand, spawnArgs } = this.buildSpawnArgs(command, args)

		this.log.debug('Executing command', {
			'namzu.sandbox.command': command,
			'namzu.sandbox.args': args,
			'namzu.sandbox.timeout': timeout,
			'namzu.execution.environment': this.environment,
		})

		// The caller's cancellation and this call's own deadline both have to
		// reach `spawn`, and `spawn` takes exactly one signal.
		//
		// Only the deadline used to. `SandboxExecOptions.signal` is declared,
		// documented, and exported, and every backend dropped it — so a Stop
		// abandoned the *wait* and left the sandboxed process running, which is
		// verbatim the failure the option's own docstring says it exists to
		// prevent. `AbortSignal.any` is what makes both reach the child: it
		// aborts as soon as either does, and — unlike an `addEventListener`
		// bridge — it does not retain a listener on the caller's long-lived
		// signal after this call settles.
		const ac = new AbortController()
		const timeoutId = setTimeout(() => ac.abort(), timeout)
		const spawnSignal = opts?.signal ? AbortSignal.any([ac.signal, opts.signal]) : ac.signal

		try {
			const result = await this.spawnProcess(spawnCommand, spawnArgs, cwd, env, ac, spawnSignal)
			return { ...result, durationMs: Date.now() - startTime }
		} finally {
			clearTimeout(timeoutId)
			if ((this._status as SandboxStatus) !== 'destroyed') {
				this._status = 'ready'
			}
		}
	}

	/**
	 * A real pseudo-terminal, or a refusal that says what to install.
	 *
	 * Deliberately NOT confined the way `exec` is. `exec` wraps every
	 * command in this class's isolation tiers (`unshare …`,
	 * `sandbox-exec …`); a terminal is an interactive session a human is
	 * driving, and wrapping it would put the tier's own shell between the
	 * operator's keystrokes and the program. So this runs inside the
	 * sandbox's ROOT DIRECTORY and nothing more — which is stated here
	 * because a caller reading "sandbox" would otherwise assume the tier
	 * applies, and it is exactly the assumption that makes a boundary
	 * imaginary.
	 *
	 * A host that needs the tier runs its interactive program through
	 * `exec` and accepts that it is not a terminal, or supplies a backend
	 * whose terminals are confined by construction — a container's `exec`,
	 * for instance, where the confinement is the container and not a
	 * wrapper.
	 */
	async openTerminal(options: OpenTerminalOptions): Promise<TerminalSession> {
		if (this._status === 'destroyed') {
			throw new Error(`Sandbox ${this.id} is destroyed`)
		}
		const pty = await loadPty(this.ptyLoader)
		return openTerminalWith(pty, options, { shell: '/bin/sh', cwd: this.rootDir })
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		if (this._status === 'destroyed') {
			throw new Error(`Sandbox ${this.id} is destroyed`)
		}

		const resolved = assertInsideSandbox(this.rootDir, path)
		await mkdir(dirname(resolved), { recursive: true })

		// Convention 8: Atomic write (write-tmp-rename)
		const tmpPath = `${resolved}.tmp.${Date.now()}`
		await fsWriteFile(tmpPath, content)
		await rename(tmpPath, resolved)

		this.log.debug('File written', { 'namzu.sandbox.path': resolved })
	}

	async readFile(path: string): Promise<Buffer> {
		if (this._status === 'destroyed') {
			throw new Error(`Sandbox ${this.id} is destroyed`)
		}

		const resolved = assertInsideSandbox(this.rootDir, path)
		return fsReadFile(resolved)
	}

	async listFiles(rootPath: string): Promise<readonly SandboxFileEntry[]> {
		if (this._status === 'destroyed') {
			throw new Error(`Sandbox ${this.id} is destroyed`)
		}

		const resolved = assertInsideSandbox(this.rootDir, rootPath)
		const root = await stat(resolved).catch(() => null)
		if (!root || !root.isDirectory()) return []

		const entries: SandboxFileEntry[] = []
		const stack: string[] = [resolved]
		while (stack.length > 0) {
			const dir = stack.pop()
			if (!dir) break
			const dirents = await readdir(dir, { withFileTypes: true }).catch(() => [])
			for (const ent of dirents) {
				const full = join(dir, ent.name)
				if (ent.isDirectory()) {
					stack.push(full)
					continue
				}
				if (!ent.isFile()) continue
				const info = await stat(full).catch(() => null)
				if (!info) continue
				entries.push({ path: full, size: info.size })
			}
		}
		return entries
	}

	async destroy(): Promise<void> {
		if (this._status === 'destroyed') {
			return
		}

		this._status = 'destroyed'
		await rm(this.rootDir, { recursive: true, force: true })

		this.log.info('Sandbox destroyed', { 'namzu.sandbox.id': this.id })
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private buildSpawnArgs(
		command: string,
		args: string[],
	): { spawnCommand: string; spawnArgs: string[] } {
		return buildLimitedSpawn({
			environment: this.environment,
			command,
			args,
			rootDir: this.rootDir,
			...(this.config.memoryLimitMb !== undefined
				? { memoryLimitMb: this.config.memoryLimitMb }
				: {}),
			...(this.config.maxProcesses !== undefined ? { maxProcesses: this.config.maxProcesses } : {}),
		})
	}

	/**
	 * @param ac      this call's own deadline — still the thing that decides
	 *                whether a termination is reported as `timedOut`.
	 * @param signal  what actually reaches `spawn`: the deadline, merged with
	 *                the caller's cancellation when one was passed. Two
	 *                parameters because they answer different questions —
	 *                "should this process die" and "did it die because it ran
	 *                too long" — and a cancelled run did not time out.
	 */
	private spawnProcess(
		command: string,
		args: string[],
		cwd: string,
		env: Record<string, string>,
		ac: AbortController,
		signal: AbortSignal = ac.signal,
	): Promise<Omit<SandboxExecResult, 'durationMs'>> {
		return new Promise((resolvePromise, rejectPromise) => {
			let child: ReturnType<typeof spawn>
			try {
				child = spawn(command, args, {
					cwd,
					env,
					stdio: ['pipe', 'pipe', 'pipe'],
					signal,
					// Leader of its own process group (POSIX only — Windows has
					// nothing to opt into here), not a member of this Node
					// process's. That is what lets `killTree` below reach `cmd`
					// and its descendants with one `-pid` signal instead of only
					// the shell sitting in front of them.
					detached: process.platform !== 'win32',
				})
			} catch (err) {
				rejectPromise(err)
				return
			}

			const stdout = new CappedStream(SANDBOX_MAX_OUTPUT_BYTES)
			const stderr = new CappedStream(SANDBOX_MAX_OUTPUT_BYTES)
			let timedOut = false

			child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
			child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

			child.on('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'ABORT_ERR' || signal.aborted) {
					// `timedOut` means the DEADLINE fired. A caller-cancelled
					// run is aborted but not late, and reporting it as a
					// timeout would tell the model to retry with a longer
					// budget for something a human just stopped.
					timedOut = ac.signal.aborted
					// `spawn`'s own `signal` handling already reached `child.pid`
					// — the outermost wrapper — but that was never the process
					// this call exists to stop. Reach the whole tree, then give
					// it a grace period before forcing it.
					killTree(child, 'SIGTERM')
					setTimeout(() => killTree(child, 'SIGKILL'), SANDBOX_KILL_GRACE_MS)
					return
				}
				rejectPromise(err)
			})

			child.on('close', (code, signal) => {
				resolvePromise({
					exitCode: code ?? (timedOut ? 124 : 1),
					stdout: stdout.text,
					stderr: stderr.text,
					signal: signal ?? undefined,
					timedOut,
					// The contract has carried these since the other backend
					// needed them, and this one clipped without setting them:
					// the model read a complete-looking result whose tail was
					// gone. The tool layer already renders the flag.
					stdoutTruncated: stdout.truncated,
					stderrTruncated: stderr.truncated,
				})
			})
		})
	}
}

// ---------------------------------------------------------------------------
// LocalSandboxProvider
// ---------------------------------------------------------------------------

export interface LocalSandboxProviderOptions {
	/**
	 * Controls this run relies on. Construction throws when the detected
	 * environment cannot enforce one of them, rather than downgrading to
	 * whatever the host happens to offer.
	 */
	readonly requireIsolation?: readonly SandboxIsolationControl[]
	/**
	 * How a sandbox loads the pty binding for {@link Sandbox.openTerminal}.
	 *
	 * Injectable so a test needs no native build. Absent means the real
	 * `import`, which is what a host gets — and what refuses, by name, when
	 * the binding is not installed.
	 */
	readonly ptyLoader?: PtyLoader
}

export class LocalSandboxProvider implements SandboxProvider {
	readonly id = 'local'
	readonly name = 'Local Sandbox'
	readonly environment: SandboxEnvironment

	private readonly log: Logger

	private readonly ptyLoader: PtyLoader | undefined

	constructor(log: Logger, options: LocalSandboxProviderOptions = {}) {
		this.ptyLoader = options.ptyLoader
		this.environment = detectEnvironment()
		this.log = log.child({ component: 'LocalSandboxProvider' })

		assertIsolation(this.environment, options.requireIsolation ?? [])

		const enforced = describeIsolation(this.environment)
		if (this.environment === 'basic') {
			// `warn`, not `info`. This tier confines nothing: the spawned
			// process sees the whole host filesystem, the whole network, and
			// every host process. The host-side controls that do survive (env
			// scrubbed to a safe key set, cwd anchored, the SDK's own file
			// helpers path-checked) are not process confinement, and a run
			// that reads "sandbox created" in its log has every reason to
			// believe otherwise.
			this.log.warn('No isolation available on this host; commands run unconfined', {
				'namzu.execution.environment': this.environment,
				'namzu.sandbox.enforced': enforced,
			})
		} else {
			this.log.info('Initialized', {
				'namzu.execution.environment': this.environment,
				'namzu.sandbox.enforced': enforced,
			})
		}
	}

	async create(config?: SandboxCreateConfig): Promise<Sandbox> {
		const id = generateSandboxId()

		// mkdtemp is in node:fs/promises but requires an async import-style usage.
		// We use the same pattern: create a unique dir under os.tmpdir().
		const { mkdtemp } = await import('node:fs/promises')
		const rawDir = await mkdtemp(join(tmpdir(), SANDBOX_TEMP_DIR_PREFIX))
		// Canonicalize — macOS symlinks like /var → /private/var must be resolved
		const rootDir = canonicalizePath(rawDir)

		this.log.info('Creating sandbox', { 'namzu.sandbox.id': id, 'namzu.sandbox.root_dir': rootDir })

		return new LocalSandbox(id, rootDir, this.environment, config ?? {}, this.log, this.ptyLoader)
	}
}

import { spawn, spawnSync } from 'node:child_process'
import { constants, accessSync, existsSync, realpathSync } from 'node:fs'
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
import { NAMZU } from '../../constants/telemetry/index.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'

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
	SandboxDestroyOptions,
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
import {
	WINDOWS_CORE_ENV_KEYS,
	applyEnvironmentOverrides,
	pickEnvironmentEntries,
} from '../../utils/process-environment.js'
import { assertIsolation, describeIsolation } from '../isolation.js'
import type { PtyLoader } from '../terminal.js'

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

const SPAWN_PROBE_SENTINEL = 'namzu-sandbox-spawn-probe'

interface SpawnProbeObservation {
	readonly error?: unknown
	readonly status: number | null
	readonly signal: NodeJS.Signals | null
	readonly stdout: string | null
}

/**
 * A wrapper is usable only when the same direct-spawn shape as a real command
 * can execute and carry its output back through a pipe.
 *
 * Checking only the exit status is insufficient: a host policy can let a
 * shell launch a namespace helper while refusing or partially virtualising a
 * direct `spawn()` of that helper. In that state the old shell-string probe
 * selected the tier, but production commands returned exit zero with empty
 * output. Treat a spawn error, signal, or damaged pipe as an unavailable tier.
 */
export function acceptsSandboxSpawnProbe(observation: SpawnProbeObservation): boolean {
	return (
		observation.error === undefined &&
		observation.status === 0 &&
		observation.signal === null &&
		observation.stdout === SPAWN_PROBE_SENTINEL
	)
}

function probeSandboxSpawn(command: string, wrapperArgs: readonly string[]): boolean {
	const observation = spawnSync(
		command,
		[
			...wrapperArgs,
			'--',
			process.execPath,
			'-e',
			`process.stdout.write(${JSON.stringify(SPAWN_PROBE_SENTINEL)})`,
		],
		{
			encoding: 'utf8',
			timeout: 5_000,
		},
	)
	return acceptsSandboxSpawnProbe(observation)
}

const TRUSTED_WRAPPER_CANDIDATES = {
	bwrap: ['/usr/bin/bwrap', '/bin/bwrap', '/usr/sbin/bwrap'],
	unshare: ['/usr/bin/unshare', '/bin/unshare', '/usr/sbin/unshare'],
	'sandbox-exec': ['/usr/bin/sandbox-exec'],
} as const

function resolveTrustedWrapper(name: keyof typeof TRUSTED_WRAPPER_CANDIDATES): string | undefined {
	for (const candidate of TRUSTED_WRAPPER_CANDIDATES[name]) {
		try {
			accessSync(candidate, constants.X_OK)
			return realpathSync(candidate)
		} catch {
			// Try the next fixed system location. Caller-controlled PATH is not
			// part of wrapper discovery because it is also configurable per run.
		}
	}
	return undefined
}

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
	/** Canonical outer wrapper selected and probed by the provider. */
	readonly wrapperCommand?: string
	readonly command: string
	readonly args: readonly string[]
	readonly rootDir: string
	readonly memoryLimitMb?: number
	readonly maxProcesses?: number
}

function requiredWrapper(request: LimitedSpawnRequest): string {
	if (request.wrapperCommand === undefined || !isAbsolute(request.wrapperCommand)) {
		throw new Error(
			`Sandbox environment ${request.environment} requires the absolute wrapper path that was probed`,
		)
	}
	return request.wrapperCommand
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
		case 'linux-bwrap':
			return {
				spawnCommand: requiredWrapper(request),
				spawnArgs: [...buildBwrapArgs(rootDir), '--', ...inner],
			}

		case 'linux-namespace':
			return {
				spawnCommand: requiredWrapper(request),
				spawnArgs: [...LINUX_UNSHARE_FLAGS, '--', ...inner],
			}

		case 'macos-seatbelt':
			return {
				spawnCommand: requiredWrapper(request),
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

type DetectedEnvironment =
	| { readonly environment: 'basic' }
	| {
			readonly environment: Exclude<SandboxEnvironment, 'basic'>
			readonly wrapperCommand: string
	  }

function detectEnvironment(): DetectedEnvironment {
	const { platform } = process

	if (platform === 'linux') {
		// Probe the direct child-process boundary used in production, including
		// its stdout pipe. A shell-string probe is a different capability on
		// hosts that mediate namespace helpers and can claim a tier production
		// cannot actually drive.
		const bwrap = resolveTrustedWrapper('bwrap')
		if (bwrap !== undefined && probeSandboxSpawn(bwrap, buildBwrapArgs(tmpdir()))) {
			return { environment: 'linux-bwrap', wrapperCommand: bwrap }
		}

		const unshare = resolveTrustedWrapper('unshare')
		if (unshare !== undefined && probeSandboxSpawn(unshare, LINUX_UNSHARE_FLAGS)) {
			return { environment: 'linux-namespace', wrapperCommand: unshare }
		}
	}

	if (platform === 'darwin') {
		const seatbelt = resolveTrustedWrapper('sandbox-exec')
		if (
			seatbelt !== undefined &&
			probeSandboxSpawn(seatbelt, ['-p', buildSeatbeltProfile(tmpdir())])
		) {
			return { environment: 'macos-seatbelt', wrapperCommand: seatbelt }
		}
	}

	return { environment: 'basic' }
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
/**
 * A mount table containing the sandbox and the system paths a binary needs,
 * and nothing else.
 *
 * The difference from the namespace tier is the whole point: that one unshares
 * a mount table and keeps the host's contents in it, so the child sees
 * everything and this file reports `filesystem: false` for it. Here each path
 * is bound in deliberately, so a path nobody listed is not unreadable — it is
 * absent. `ls /home` fails with ENOENT rather than EACCES, which is the
 * behaviour a caller relying on `filesystem` isolation is entitled to.
 *
 * `--unshare-all` covers the network and process controls in the same call, so
 * all three rows of this tier's isolation report come from one spawn rather
 * than from three mechanisms that could drift apart.
 *
 * The system paths are bound READ-ONLY and only when present: a distribution
 * with a merged `/usr` has no real `/lib`, and binding a path that does not
 * exist is a hard failure rather than a no-op. `/proc` and `/dev` get their
 * own fresh instances instead of a bind, so the child cannot read the host's
 * process table through them — a bound `/proc` would hand back the process
 * isolation the same flag just removed.
 */
export function buildBwrapArgs(sandboxRoot: string): string[] {
	const root = canonicalizePath(sandboxRoot)

	const args = [
		'--unshare-all',
		// The child dies with the parent rather than outliving a killed run.
		// Without it an escaped grandchild keeps the mount namespace alive and
		// the sandbox's temporary root cannot be removed.
		'--die-with-parent',
		'--new-session',
	]

	for (const path of BWRAP_SYSTEM_PATHS) {
		if (existsSync(path)) args.push('--ro-bind', path, path)
	}

	// The runtime this process is running under, when it lives outside those.
	//
	// Found by the tier breaking four existing tests the moment it worked: they
	// spawn `node` inside the sandbox, and a Node installed under a home
	// directory — a tarball, a version manager, anything but the distribution's
	// package — is simply not there once the host filesystem is gone. The
	// failure reads as `execvp: No such file or directory`, which sounds like a
	// broken test rather than a sandbox doing its job.
	//
	// The PREFIX rather than the `bin` directory: `bin` alone is enough to run
	// `node`, but `npm` and `npx` resolve their own code through `../lib`, and a
	// model that runs one of those is not doing anything unusual.
	//
	// Read-only, and skipped when a system path already covers it, so a
	// distribution-packaged runtime adds no second bind.
	const interpreterPrefix = dirname(dirname(canonicalizePath(process.execPath)))
	const alreadyCovered = BWRAP_SYSTEM_PATHS.some(
		(path) => interpreterPrefix === path || interpreterPrefix.startsWith(`${path}/`),
	)
	if (!alreadyCovered && existsSync(interpreterPrefix)) {
		args.push('--ro-bind', interpreterPrefix, interpreterPrefix)
	}

	args.push(
		'--proc',
		'/proc',
		'--dev',
		'/dev',
		// A private /tmp, because the sandbox root is where writes belong and a
		// shared /tmp is a channel between runs.
		'--tmpfs',
		'/tmp',
		'--bind',
		root,
		root,
		'--chdir',
		root,
	)

	return args
}

/**
 * Read-only host paths a spawned binary needs to run at all.
 *
 * Bound rather than assumed: `/etc` carries the resolver and user database a
 * shell reads on startup, and omitting it produces failures that look like the
 * command is broken rather than like the sandbox is doing its job.
 */
const BWRAP_SYSTEM_PATHS: readonly string[] = [
	'/usr',
	'/bin',
	'/sbin',
	'/lib',
	'/lib64',
	'/etc',
	'/opt',
]

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
	const allowed =
		process.platform === 'win32'
			? [...SANDBOX_SAFE_ENV_KEYS, ...WINDOWS_CORE_ENV_KEYS]
			: SANDBOX_SAFE_ENV_KEYS
	const env = pickEnvironmentEntries(allowed)

	applyEnvironmentOverrides(env, configEnv)
	applyEnvironmentOverrides(env, optsEnv)

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

	constructor(
		id: SandboxId,
		rootDir: string,
		environment: SandboxEnvironment,
		private readonly wrapperCommand: string | undefined,
		config: SandboxCreateConfig,
		log: Logger,
	) {
		this.id = id
		this.rootDir = rootDir
		this.environment = environment
		this.config = config
		this._status = 'ready'
		this.log = log.child({ [SCOPE_ATTRIBUTE]: 'sandbox/provider/local', [NAMZU.SANDBOX_ID]: id })

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

	async destroy(_options?: SandboxDestroyOptions): Promise<void> {
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
			...(this.wrapperCommand !== undefined ? { wrapperCommand: this.wrapperCommand } : {}),
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
	 * Legacy test injection for the local backend's former terminal method.
	 *
	 * @deprecated The local backend cannot preserve its selected isolation
	 * tier or own the complete terminal process tree, so it no longer exposes
	 * `Sandbox.openTerminal`. Supplying this option now throws. Use the
	 * host-scoped terminal helpers directly only when unconfined execution is
	 * intentional, or provide a backend that owns confinement and teardown.
	 */
	readonly ptyLoader?: PtyLoader
}

export class LocalSandboxProvider implements SandboxProvider {
	readonly id = 'local'
	readonly name = 'Local Sandbox'
	readonly environment: SandboxEnvironment

	private readonly log: Logger
	private readonly wrapperCommand: string | undefined

	constructor(log: Logger, options: LocalSandboxProviderOptions = {}) {
		if (options.ptyLoader !== undefined) {
			throw new Error(
				'LocalSandboxProvider no longer accepts ptyLoader because its terminal could not preserve the selected isolation tier or sandbox teardown ownership. Use the host-scoped terminal helpers only for intentional host execution, or provide a confined terminal backend.',
			)
		}
		const detected = detectEnvironment()
		this.environment = detected.environment
		this.wrapperCommand = 'wrapperCommand' in detected ? detected.wrapperCommand : undefined
		this.log = log.child({ [SCOPE_ATTRIBUTE]: 'sandbox/provider/local' })

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
		config?.signal?.throwIfAborted()
		const id = generateSandboxId()

		// mkdtemp is in node:fs/promises but requires an async import-style usage.
		// We use the same pattern: create a unique dir under os.tmpdir().
		const { mkdtemp } = await import('node:fs/promises')
		const rawDir = await mkdtemp(join(tmpdir(), SANDBOX_TEMP_DIR_PREFIX))
		if (config?.signal?.aborted) {
			await rm(rawDir, { recursive: true, force: true })
			throw config.signal.reason
		}
		// Canonicalize — macOS symlinks like /var → /private/var must be resolved
		const rootDir = canonicalizePath(rawDir)

		this.log.info('Creating sandbox', { 'namzu.sandbox.id': id, 'namzu.sandbox.root_dir': rootDir })

		return new LocalSandbox(
			id,
			rootDir,
			this.environment,
			this.wrapperCommand,
			config ?? {},
			this.log,
		)
	}
}

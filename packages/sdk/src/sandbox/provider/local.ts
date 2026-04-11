import { execSync, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import {
	readFile as fsReadFile,
	writeFile as fsWriteFile,
	mkdir,
	rename,
	rm,
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
import type { SandboxId } from '../../types/ids/index.js'
import type {
	Sandbox,
	SandboxCreateConfig,
	SandboxEnvironment,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxProvider,
	SandboxStatus,
} from '../../types/sandbox/index.js'
import { generateSandboxId } from '../../utils/id.js'
import type { Logger } from '../../utils/logger.js'

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

function detectEnvironment(): SandboxEnvironment {
	const { platform } = process

	if (platform === 'linux') {
		try {
			execSync('unshare --version', { stdio: 'ignore' })
			return 'linux-namespace'
		} catch {
			// unshare not available
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
 *
 * Reference: Anthropic sandbox-runtime normalizePathForSandbox()
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
 * Reference: Anthropic sandbox-runtime generateSandboxProfile()
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

	constructor(
		id: SandboxId,
		rootDir: string,
		environment: SandboxEnvironment,
		config: SandboxCreateConfig,
		log: Logger,
	) {
		this.id = id
		this.rootDir = rootDir
		this.environment = environment
		this.config = config
		this._status = 'ready'
		this.log = log.child({ component: 'LocalSandbox', sandboxId: id })

		this.log.info('Sandbox created', { rootDir, environment })
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

		this.log.debug('Executing command', { command, args, timeout, environment: this.environment })

		const ac = new AbortController()
		const timeoutId = setTimeout(() => ac.abort(), timeout)

		try {
			const result = await this.spawnProcess(spawnCommand, spawnArgs, cwd, env, ac)
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

		this.log.debug('File written', { path: resolved })
	}

	async readFile(path: string): Promise<Buffer> {
		if (this._status === 'destroyed') {
			throw new Error(`Sandbox ${this.id} is destroyed`)
		}

		const resolved = assertInsideSandbox(this.rootDir, path)
		return fsReadFile(resolved)
	}

	async destroy(): Promise<void> {
		if (this._status === 'destroyed') {
			return
		}

		this._status = 'destroyed'
		await rm(this.rootDir, { recursive: true, force: true })

		this.log.info('Sandbox destroyed', { sandboxId: this.id })
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private buildSpawnArgs(
		command: string,
		args: string[],
	): { spawnCommand: string; spawnArgs: string[] } {
		switch (this.environment) {
			case 'linux-namespace':
				return {
					spawnCommand: 'unshare',
					spawnArgs: ['--mount', '--pid', '--fork', '--map-root-user', '--', command, ...args],
				}

			case 'macos-seatbelt': {
				const profile = buildSeatbeltProfile(this.rootDir)
				return {
					spawnCommand: 'sandbox-exec',
					spawnArgs: ['-p', profile, '--', command, ...args],
				}
			}

			case 'basic': {
				const limits: string[] = []

				const memoryMb = this.config.memoryLimitMb
				if (memoryMb !== undefined) {
					const memoryKb = memoryMb * 1024
					limits.push(`ulimit -v ${memoryKb}`)
				}

				const maxProcs = this.config.maxProcesses
				if (maxProcs !== undefined) {
					limits.push(`ulimit -u ${maxProcs}`)
				}

				if (limits.length > 0) {
					const prefix = limits.join(' && ')
					const fullCommand = `${prefix} && ${command} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`
					return {
						spawnCommand: '/bin/sh',
						spawnArgs: ['-c', fullCommand],
					}
				}

				return { spawnCommand: command, spawnArgs: args }
			}

			default: {
				const _exhaustive: never = this.environment
				throw new Error(`Unknown sandbox environment: ${_exhaustive}`)
			}
		}
	}

	private spawnProcess(
		command: string,
		args: string[],
		cwd: string,
		env: Record<string, string>,
		ac: AbortController,
	): Promise<Omit<SandboxExecResult, 'durationMs'>> {
		return new Promise((resolvePromise, rejectPromise) => {
			let child: ReturnType<typeof spawn>
			try {
				child = spawn(command, args, {
					cwd,
					env,
					stdio: ['pipe', 'pipe', 'pipe'],
					signal: ac.signal,
				})
			} catch (err) {
				rejectPromise(err)
				return
			}

			let stdout = ''
			let stderr = ''
			let stdoutBytes = 0
			let stderrBytes = 0
			let timedOut = false

			child.stdout?.on('data', (chunk: Buffer) => {
				if (stdoutBytes < SANDBOX_MAX_OUTPUT_BYTES) {
					const remaining = SANDBOX_MAX_OUTPUT_BYTES - stdoutBytes
					stdout += chunk.subarray(0, remaining).toString('utf-8')
				}
				stdoutBytes += chunk.length
			})

			child.stderr?.on('data', (chunk: Buffer) => {
				if (stderrBytes < SANDBOX_MAX_OUTPUT_BYTES) {
					const remaining = SANDBOX_MAX_OUTPUT_BYTES - stderrBytes
					stderr += chunk.subarray(0, remaining).toString('utf-8')
				}
				stderrBytes += chunk.length
			})

			child.on('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'ABORT_ERR' || ac.signal.aborted) {
					timedOut = true
					// Give process a grace period, then SIGKILL
					if (child.pid) {
						setTimeout(() => {
							try {
								child.kill('SIGKILL')
							} catch {
								// Process may have already exited
							}
						}, SANDBOX_KILL_GRACE_MS)
					}
					return
				}
				rejectPromise(err)
			})

			child.on('close', (code, signal) => {
				resolvePromise({
					exitCode: code ?? (timedOut ? 124 : 1),
					stdout,
					stderr,
					signal: signal ?? undefined,
					timedOut,
				})
			})
		})
	}
}

// ---------------------------------------------------------------------------
// LocalSandboxProvider
// ---------------------------------------------------------------------------

export class LocalSandboxProvider implements SandboxProvider {
	readonly id = 'local'
	readonly name = 'Local Sandbox'
	readonly environment: SandboxEnvironment

	private readonly log: Logger

	constructor(log: Logger) {
		this.environment = detectEnvironment()
		this.log = log.child({ component: 'LocalSandboxProvider' })

		this.log.info('Initialized', { environment: this.environment })
	}

	async create(config?: SandboxCreateConfig): Promise<Sandbox> {
		const id = generateSandboxId()

		// mkdtemp is in node:fs/promises but requires an async import-style usage.
		// We use the same pattern: create a unique dir under os.tmpdir().
		const { mkdtemp } = await import('node:fs/promises')
		const rawDir = await mkdtemp(join(tmpdir(), SANDBOX_TEMP_DIR_PREFIX))
		// Canonicalize — macOS symlinks like /var → /private/var must be resolved
		const rootDir = canonicalizePath(rawDir)

		this.log.info('Creating sandbox', { sandboxId: id, rootDir })

		return new LocalSandbox(id, rootDir, this.environment, config ?? {}, this.log)
	}
}

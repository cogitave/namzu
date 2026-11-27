/**
 * Git, run the way a download from a stranger has to be.
 *
 * The system `git` is started with `execFile`-style arguments (never a shell),
 * in an environment with every `GIT_*` variable removed and these set: no
 * terminal prompt, no askpass program, ssh in batch mode with host keys
 * checked, protocols limited to https and ssh (file only when a test says so),
 * and LFS content never downloaded. The command line adds: no hooks, no
 * fsmonitor, links checked out as plain files, `ext::` refused, and every
 * object checked on receipt. Credentials are whatever the person's own Git
 * is set up with; a prompt cannot appear.
 *
 * A run is stopped after a timeout (120 s, or NAMZU_PLUGIN_GIT_TIMEOUT_MS up
 * to 600 s) by killing its whole process group, or its process tree on
 * Windows. Output is kept to 1 MiB.
 */

import { type SpawnOptions, execFile, spawn } from 'node:child_process'
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
} from 'node:fs'
import { join } from 'node:path'

import {
	EXIT_DATAERR,
	EXIT_FAIL,
	EXIT_NOINPUT,
	EXIT_UNAVAILABLE,
	EXIT_USAGE,
} from '../../../exit-codes.js'
import { gitUrlProblem, isCommitId, repoPathProblem } from './source.js'

/** A fetch that did not work, with the exit status it maps to and a sentence for a person. */
export class FetchError extends Error {
	override readonly name = 'FetchError'
	constructor(
		readonly code: number,
		message: string,
		readonly kind: string,
	) {
		super(message)
	}
}

export const DEFAULT_GIT_TIMEOUT_MS = 120_000
export const MAX_GIT_TIMEOUT_MS = 600_000
export const GIT_OUTPUT_CAP = 1024 * 1024

/** The timeout from the environment, clamped; anything unreadable is the default. */
export function gitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.NAMZU_PLUGIN_GIT_TIMEOUT_MS
	if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_GIT_TIMEOUT_MS
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_GIT_TIMEOUT_MS
	return Math.min(value, MAX_GIT_TIMEOUT_MS)
}

export interface GitRun {
	readonly code: number | null
	readonly stdout: string
	readonly stderr: string
	readonly timedOut: boolean
	/** The `git` program was not found. */
	readonly missing: boolean
}

export interface GitRunOptions {
	readonly cwd?: string
	readonly env: NodeJS.ProcessEnv
	readonly timeoutMs: number
}

export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitRun>

export interface FetchOptions {
	/** Test only: let `file://` and plain-path repositories be cloned. Never set by a command. */
	readonly allowFileProtocol?: boolean
	/** Test only: where a remote address really points. */
	readonly rewriteUrl?: (url: string) => string
	/** Test only: plain `http://127.0.0.1` for the fake server of a catalog or archive. */
	readonly allowLoopbackHttp?: boolean
	/** Test only: replaces `fetch`. */
	readonly fetchImpl?: typeof fetch
	readonly timeoutMs?: number
	readonly runner?: GitRunner
	readonly env?: NodeJS.ProcessEnv
}

export interface RunnerDeps {
	readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildLike
	readonly killTree?: (pid: number) => void
	readonly setTimeout?: (fn: () => void, ms: number) => unknown
	readonly clearTimeout?: (handle: unknown) => void
	readonly platform?: NodeJS.Platform
}

export interface ChildLike {
	readonly pid?: number
	readonly stdout: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown } | null
	readonly stderr: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown } | null
	on(event: 'error', fn: (error: NodeJS.ErrnoException) => void): unknown
	on(event: 'close', fn: (code: number | null) => void): unknown
	kill(signal?: NodeJS.Signals): unknown
}

/** Stop a process and everything it started: the group on POSIX, the tree on Windows. */
function killProcessTree(pid: number, platform: NodeJS.Platform): void {
	if (platform === 'win32') {
		execFile(
			join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
			['/PID', String(pid), '/T', '/F'],
			{ windowsHide: true, timeout: 5000 },
			() => undefined,
		)
		return
	}
	try {
		process.kill(-pid, 'SIGKILL')
	} catch {
		try {
			process.kill(pid, 'SIGKILL')
		} catch {
			// Already gone.
		}
	}
}

/** The runner that starts the system `git`. Its parts can be replaced so a test never needs a real process or a real clock. */
export function createGitRunner(deps: RunnerDeps = {}): GitRunner {
	const platform = deps.platform ?? process.platform
	const start =
		deps.spawn ??
		((command, args, options) => spawn(command, [...args], options) as unknown as ChildLike)
	const kill = deps.killTree ?? ((pid: number) => killProcessTree(pid, platform))
	const later = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
	const cancel = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout))
	return (args, options) =>
		new Promise<GitRun>((resolve) => {
			let stdout = ''
			let stderr = ''
			let done = false
			let timedOut = false
			const finish = (code: number | null, missing = false): void => {
				if (done) return
				done = true
				cancel(timer)
				resolve({ code, stdout, stderr, timedOut, missing })
			}
			const child = start('git', args, {
				...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
				env: options.env,
				shell: false,
				detached: platform !== 'win32',
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			const take = (current: string, chunk: Buffer | string): string =>
				current.length >= GIT_OUTPUT_CAP
					? current
					: (current + String(chunk)).slice(0, GIT_OUTPUT_CAP)
			child.stdout?.on('data', (chunk) => {
				stdout = take(stdout, chunk)
			})
			child.stderr?.on('data', (chunk) => {
				stderr = take(stderr, chunk)
			})
			child.on('error', (error) => {
				if (error.code === 'ENOENT') finish(null, true)
				else {
					stderr = take(stderr, error.message)
					finish(null)
				}
			})
			child.on('close', (code) => finish(code))
			const timer = later(() => {
				timedOut = true
				if (child.pid !== undefined) kill(child.pid)
				else child.kill('SIGKILL')
				finish(null)
			}, options.timeoutMs)
		})
}

const defaultRunner = createGitRunner()

/** The environment git runs in: the person's own, with every `GIT_*` variable removed and ours set. */
export function gitEnvironment(base: NodeJS.ProcessEnv, allowFile: boolean): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(base))
		if (value !== undefined && !/^GIT_/i.test(key)) env[key] = value
	env.GIT_TERMINAL_PROMPT = '0'
	env.GIT_ASKPASS = ''
	env.SSH_ASKPASS = ''
	env.SSH_ASKPASS_REQUIRE = 'never'
	env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'
	env.GIT_ALLOW_PROTOCOL = allowFile ? 'https:ssh:file' : 'https:ssh'
	env.GIT_LFS_SKIP_SMUDGE = '1'
	env.GIT_OPTIONAL_LOCKS = '0'
	env.LC_ALL = 'C'
	env.LANG = 'C'
	return env
}

/** The `-c` settings every run carries. */
export function gitSettings(
	allowFile: boolean,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const nullDevice = platform === 'win32' ? 'NUL' : '/dev/null'
	const settings = [
		`core.hooksPath=${nullDevice}`,
		'core.fsmonitor=false',
		'core.symlinks=false',
		'protocol.ext.allow=never',
		`protocol.file.allow=${allowFile ? 'always' : 'never'}`,
		'transfer.fsckObjects=true',
		'fetch.fsckObjects=true',
		'receive.fsckObjects=true',
		'submodule.recurse=false',
		'fetch.recurseSubmodules=false',
		'core.autocrlf=false',
	]
	return settings.flatMap((setting) => ['-c', setting])
}

function hostOf(url: string): string {
	const scp = /^[^@/]+@([^:/]+):/.exec(url)
	if (scp !== null) return scp[1] as string
	try {
		return new URL(url).hostname
	} catch {
		return 'that host'
	}
}

/** The sentence and exit status for a git run that failed. */
export function explainGitFailure(run: GitRun, url: string, timeoutMs: number): FetchError {
	if (run.missing)
		return new FetchError(
			EXIT_UNAVAILABLE,
			'Git is needed for this address. Install Git and run the command again.',
			'git-missing',
		)
	if (run.timedOut)
		return new FetchError(
			EXIT_UNAVAILABLE,
			`Git took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. Try again, or raise NAMZU_PLUGIN_GIT_TIMEOUT_MS (at most 600000).`,
			'timeout',
		)
	const text = run.stderr
	if (
		/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey|Host key verification failed|no (supported )?authentication/i.test(
			text,
		)
	)
		return new FetchError(
			EXIT_NOINPUT,
			`Repository not found or not accessible: ${hostOf(url)} asked for a sign-in. Namzu uses your own Git setup and cannot ask for a password.`,
			'auth',
		)
	if (
		/Remote branch .* not found|couldn't find remote ref|not our ref|did not match any|invalid reference|reference is not a tree|unadvertised object/i.test(
			text,
		)
	)
		return new FetchError(
			EXIT_NOINPUT,
			'That branch, tag or commit does not exist in the repository.',
			'ref',
		)
	if (
		/Repository not found|not found|does not appear to be a git repository|does not exist|404/i.test(
			text,
		)
	)
		return new FetchError(
			EXIT_NOINPUT,
			'Repository not found or not accessible. Check the address, and that your own Git setup may read it.',
			'not-found',
		)
	if (
		/Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|Network is unreachable|unable to access|Could not resolve hostname|Operation timed out/i.test(
			text,
		)
	)
		return new FetchError(EXIT_UNAVAILABLE, `Could not reach ${hostOf(url)}.`, 'network')
	if (/protocol .* is not allowed|transport .* not allowed/i.test(text))
		return new FetchError(EXIT_DATAERR, 'That kind of address is not allowed.', 'protocol')
	if (
		/fsck|bad object|corrupt|object .* is (broken|invalid)|invalid .* in (commit|tree)/i.test(text)
	)
		return new FetchError(
			EXIT_DATAERR,
			'The repository failed Git’s integrity checks, so nothing was taken from it.',
			'fsck',
		)
	const first = text
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line !== '')
	return new FetchError(
		EXIT_FAIL,
		`Git could not fetch the repository${
			first !== undefined
				? ` (${[...first]
						.map((c) => (c.charCodeAt(0) < 32 ? ' ' : c))
						.join('')
						.slice(0, 200)})`
				: ''
		}.`,
		'git',
	)
}

export interface CloneRequest {
	readonly url: string
	readonly ref?: string
	/** The commit the result must be at. Fetched by id, so a moved branch cannot satisfy it. */
	readonly sha?: string
	readonly sparsePaths?: readonly string[]
	/** A folder that does not exist yet, or is empty. */
	readonly dest: string
}

export interface CloneResult {
	readonly commit: string
	/** Files that are Git LFS pointers: their content was not downloaded. */
	readonly lfsPointers: number
	/** Submodules the repository lists: none was downloaded. */
	readonly submodules: number
}

class Git {
	readonly env: NodeJS.ProcessEnv
	readonly settings: string[]
	readonly timeoutMs: number
	readonly runner: GitRunner
	constructor(readonly options: FetchOptions) {
		const allowFile = options.allowFileProtocol === true
		this.env = gitEnvironment(options.env ?? process.env, allowFile)
		this.settings = gitSettings(allowFile)
		this.timeoutMs = options.timeoutMs ?? gitTimeoutMs(options.env ?? process.env)
		this.runner = options.runner ?? defaultRunner
	}
	async run(args: readonly string[], url: string, cwd?: string): Promise<GitRun> {
		const run = await this.runner([...this.settings, ...args], {
			...(cwd !== undefined ? { cwd } : {}),
			env: this.env,
			timeoutMs: this.timeoutMs,
		})
		if (run.code !== 0) throw explainGitFailure(run, url, this.timeoutMs)
		return run
	}
}

const LFS_HEADER = 'version https://git-lfs.github.com/spec/v1'

/** Count files that are Git LFS pointers (small, starting with the pointer header). */
export function countLfsPointers(root: string): number {
	let count = 0
	let seen = 0
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === '.git') continue
			const path = join(dir, entry.name)
			if (entry.isDirectory()) walk(path)
			else if (entry.isFile()) {
				if (++seen > 50_000) return
				try {
					const stat = lstatSync(path)
					if (stat.size < 20 || stat.size > 1024) continue
					const fd = openSync(path, 'r')
					try {
						const head = Buffer.alloc(LFS_HEADER.length)
						readSync(fd, head, 0, head.length, 0)
						if (head.toString('utf8') === LFS_HEADER) count += 1
					} finally {
						closeSync(fd)
					}
				} catch {
					// A file that cannot be read is not counted.
				}
			}
		}
	}
	try {
		walk(root)
	} catch {
		// A tree that cannot be walked has no counted pointers.
	}
	return count
}

/**
 * Clone a repository into `request.dest`, shallow when it can be, never
 * running anything from it and never fetching its submodules or LFS content.
 * A pinned `sha` is fetched by id and checked. Refusals are {@link FetchError}.
 */
export async function cloneRepository(
	request: CloneRequest,
	options: FetchOptions = {},
): Promise<CloneResult> {
	const allowFile = options.allowFileProtocol === true
	const problem = gitUrlProblem(request.url, allowFile)
	if (problem !== undefined)
		throw new FetchError(
			EXIT_USAGE,
			`${hostOf(request.url)} cannot be used: ${problem}.`,
			'address',
		)
	const sparse = request.sparsePaths ?? []
	for (const path of sparse) {
		const bad = repoPathProblem(path)
		if (bad !== undefined) throw new FetchError(EXIT_USAGE, bad, 'path')
	}
	const url = options.rewriteUrl?.(request.url) ?? request.url
	const git = new Git(options)
	const byId =
		request.sha ?? (request.ref !== undefined && isCommitId(request.ref) ? request.ref : undefined)
	const filter = sparse.length > 0 ? ['--filter=blob:none'] : []
	mkdirSync(request.dest, { recursive: true, mode: 0o700 })
	if (byId !== undefined) {
		await git.run(['init', '--quiet'], request.url, request.dest)
		await git.run(['remote', 'add', 'origin', url], request.url, request.dest)
		if (sparse.length > 0)
			await git.run(
				['sparse-checkout', 'set', '--cone', '--', ...sparse],
				request.url,
				request.dest,
			)
		await git.run(
			['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', ...filter, 'origin', byId],
			request.url,
			request.dest,
		)
		await git.run(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], request.url, request.dest)
	} else {
		await git.run(
			[
				'clone',
				'--quiet',
				'--depth',
				'1',
				'--no-tags',
				'--single-branch',
				'--no-recurse-submodules',
				...(request.ref !== undefined ? ['--branch', request.ref] : []),
				...(sparse.length > 0 ? [...filter, '--sparse'] : []),
				'--',
				url,
				request.dest,
			],
			request.url,
		)
		if (sparse.length > 0)
			await git.run(
				['sparse-checkout', 'set', '--cone', '--', ...sparse],
				request.url,
				request.dest,
			)
	}
	const head = await git.run(['rev-parse', 'HEAD'], request.url, request.dest)
	const commit = head.stdout.trim()
	if (!isCommitId(commit))
		throw new FetchError(EXIT_FAIL, 'Git did not say which commit it fetched.', 'git')
	if (request.sha !== undefined && commit !== request.sha.toLowerCase())
		throw new FetchError(
			EXIT_DATAERR,
			`The repository is at ${commit.slice(0, 7)}, not the commit ${request.sha.slice(0, 7)} it is pinned to. Nothing was taken from it.`,
			'pin',
		)
	let submodules = 0
	try {
		const files = await git.run(['ls-files', '--stage'], request.url, request.dest)
		submodules = files.stdout.split('\n').filter((line) => line.startsWith('160000 ')).length
	} catch {
		// A listing that fails counts none.
	}
	if (submodules === 0 && existsSync(join(request.dest, '.gitmodules'))) {
		try {
			submodules = (
				readFileSync(join(request.dest, '.gitmodules'), 'utf8').match(/^\s*\[submodule /gm) ?? []
			).length
		} catch {
			// Unreadable: not counted.
		}
	}
	return { commit, lfsPointers: countLfsPointers(request.dest), submodules }
}

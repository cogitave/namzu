import { spawn } from 'node:child_process'
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	unlinkSync,
} from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'

import { resolveNpmInvocation } from './npm-invocation.js'

export interface NpmUpgradeRequest {
	readonly executable: string
	readonly args: readonly string[]
	readonly prefix: string
	readonly onOutput?: (text: string) => void
	/**
	 * Where a background run writes what the package manager prints (both streams,
	 * replaced each run). A file, not a pipe: the package manager outlives this
	 * process, and a pipe whose reader is gone would end its install half way.
	 * `onOutput` then gets the last part of the file once the run ends.
	 */
	readonly logFile?: string
	/** Run without a terminal: nothing is read from the person's stdin and nothing is written to it. */
	readonly background?: boolean
	/** Kill the package manager after this many milliseconds. */
	readonly timeoutMs?: number
	/** Called with the package manager's process id once it has started. */
	readonly onSpawn?: (pid: number) => void
}

/**
 * Remove npm's `namzu.ps1` shim from a global prefix so a bare `namzu` in
 * PowerShell resolves to `namzu.cmd`. PowerShell prefers the `.ps1`, and under
 * the default execution policy it refuses to run ("running scripts is
 * disabled"); npm writes it again on every install. Only that one file, and
 * only when it sits beside `namzu.cmd` and names `@namzu/cli`. Returns whether
 * a file was removed; never throws.
 */
export function removeOwnPowerShellShim(prefix: string): boolean {
	try {
		const shim = join(prefix, 'namzu.ps1')
		if (!existsSync(shim) || !existsSync(join(prefix, 'namzu.cmd'))) return false
		if (!/@namzu[\\/]cli/.test(readFileSync(shim, 'utf8'))) return false
		unlinkSync(shim)
		return true
	} catch {
		return false
	}
}

/**
 * Derive the prefix owning an npm-global @namzu/cli package.
 *
 * The executing package root is authority. Ambient `npm prefix -g` may point
 * at a different Node installation, especially under version managers, so it
 * is deliberately not consulted.
 */
export function npmGlobalPrefixFor(packageRoot: string, platform: NodeJS.Platform): string | null {
	const paths = platform === 'win32' ? win32 : posix
	const root = paths.resolve(packageRoot)
	const expectedTail =
		platform === 'win32'
			? paths.join('node_modules', '@namzu', 'cli')
			: paths.join('lib', 'node_modules', '@namzu', 'cli')
	const comparableRoot = platform === 'win32' ? root.toLowerCase() : root
	const comparableTail = platform === 'win32' ? expectedTail.toLowerCase() : expectedTail
	const suffix = `${paths.sep}${comparableTail}`
	if (!comparableRoot.endsWith(suffix)) return null
	const prefix = root.slice(0, root.length - suffix.length)
	return prefix.length > 0 ? prefix : paths.parse(root).root
}

/** How much of the end of a background run's log is handed back. */
const LOG_TAIL_BYTES = 16_384

function readTail(path: string): string {
	let fd: number | undefined
	try {
		fd = openSync(path, 'r')
		const size = statSync(path).size
		const length = Math.min(size, LOG_TAIL_BYTES)
		const buffer = Buffer.alloc(length)
		readSync(fd, buffer, 0, length, size - length)
		return buffer.toString('utf8')
	} catch {
		return ''
	} finally {
		if (fd !== undefined) closeSync(fd)
	}
}

export function runNpmUpgrade(request: NpmUpgradeRequest): Promise<number> {
	return new Promise((resolveRun, reject) => {
		const invocation = resolveNpmInvocation(request.executable, request.args)
		let logFd: number | undefined
		if (request.background && request.logFile) {
			mkdirSync(dirname(request.logFile), { recursive: true })
			logFd = openSync(request.logFile, 'w')
		}
		const closeLog = () => {
			if (logFd !== undefined) closeSync(logFd)
			logFd = undefined
		}
		let child: ReturnType<typeof spawn>
		try {
			child = spawn(invocation.executable, [...invocation.args], {
				cwd: request.prefix,
				env: process.env,
				stdio: request.background
					? logFd !== undefined
						? ['ignore', logFd, logFd]
						: ['ignore', 'ignore', 'ignore']
					: request.onOutput
						? ['inherit', 'pipe', 'pipe']
						: 'inherit',
				...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
				shell: false,
				windowsHide: true,
				// Its own process group: closing the terminal or pressing Ctrl+C must not
				// stop the package manager half way through replacing the package.
				...(request.background ? { detached: true } : {}),
			})
		} catch (error) {
			closeLog()
			reject(error)
			return
		}
		// The child has its own copy of the descriptor now.
		closeLog()
		if (child.pid !== undefined) request.onSpawn?.(child.pid)
		if (request.onOutput && !request.background) {
			child.stdout?.setEncoding('utf8').on('data', request.onOutput)
			child.stderr?.setEncoding('utf8').on('data', request.onOutput)
		}
		child.once('error', reject)
		child.once('close', (code) => {
			if (request.background && request.logFile && request.onOutput) {
				const tail = readTail(request.logFile)
				if (tail) request.onOutput(tail)
			}
			resolveRun(code ?? 1)
		})
	})
}

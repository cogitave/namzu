import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Manifest } from './types.js'

/** The pipe to a running extension process, as the supervisor sees it. */
export interface ChildLike {
	readonly pid: number | undefined
	write(line: string): void
	endInput(): void
	kill(force: boolean): void
	onLine(cb: (line: string) => void): void
	onExit(cb: (code: number | null, signal: string | null) => void): void
}

export interface SpawnSpec {
	readonly exe: string
	readonly args: readonly string[]
	readonly cwd: string
	readonly env: Record<string, string>
	readonly stderrLog?: string
}

const STDERR_CAP = 256 * 1024

/**
 * The environment is built from scratch: a minimal system set, the data folder as home, the manifest's
 * own `env`, and `NAMZU_EXT_*`. No `NAMZU_*` key of the host, no `*_API_KEY`, nothing inherited; the
 * secret setting is never passed.
 */
export function cleanEnv(input: {
	manifest: Manifest
	platform: NodeJS.Platform
	hostEnv: NodeJS.ProcessEnv
	extensionDir: string
	dataDir: string
	runDir: string
	consentPath: string
	licensePath: string
	granted: readonly string[]
	queryAddr: string
	locale: string
}): Record<string, string> {
	const { manifest: m, hostEnv, platform } = input
	const env: Record<string, string> = {}
	const take = (name: string) => {
		const v = hostEnv[name]
		if (v !== undefined) env[name] = v
	}
	if (platform === 'win32') {
		for (const n of [
			'SystemRoot',
			'SystemDrive',
			'windir',
			'TEMP',
			'TMP',
			'USERNAME',
			'USERPROFILE',
		])
			take(n)
		env.LOCALAPPDATA = input.dataDir
	} else {
		env.PATH = '/usr/local/bin:/usr/bin:/bin'
		env.LANG = hostEnv.LANG ?? 'C.UTF-8'
		env.HOME = input.dataDir
	}
	const subst = (v: string) =>
		v.replace(
			/\$\{(\w+)\}/g,
			(_x, k: string) =>
				({
					extensionDir: input.extensionDir,
					dataDir: input.dataDir,
					id: m.id,
					version: m.version,
					locale: input.locale,
				})[k] ?? '',
		)
	for (const [k, v] of Object.entries(m.entry.process.env ?? {})) env[k] = subst(v)
	Object.assign(env, {
		NAMZU_EXT_API: '1',
		NAMZU_EXT_ID: m.id,
		NAMZU_EXT_VERSION: m.version,
		NAMZU_EXT_DATA: input.dataDir,
		NAMZU_EXT_RUN: input.runDir,
		NAMZU_EXT_CONSENT: input.consentPath,
		NAMZU_EXT_LICENSE: input.licensePath,
		NAMZU_EXT_GRANTED: input.granted.join(','),
		NAMZU_EXT_QUERY_ADDR: input.queryAddr,
		NAMZU_EXT_LOCALE: input.locale,
	})
	return env
}

export function spawnChild(
	spec: SpawnSpec,
	platform: NodeJS.Platform = process.platform,
): ChildLike {
	const child: ChildProcess = spawn(spec.exe, [...spec.args], {
		cwd: spec.cwd,
		shell: false,
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: spec.env,
		// Its own process group on POSIX, so the whole group can be stopped.
		detached: platform !== 'win32',
	})
	const lines: ((l: string) => void)[] = []
	let pending = ''
	child.stdout?.setEncoding('utf8')
	child.stdout?.on('data', (chunk: string) => {
		pending += chunk
		let at = pending.indexOf('\n')
		while (at >= 0) {
			const line = pending.slice(0, at)
			pending = pending.slice(at + 1)
			for (const cb of lines) cb(line)
			at = pending.indexOf('\n')
		}
		// A line that never ends is refused by length, as a line.
		if (pending.length > 65536) {
			for (const cb of lines) cb(pending)
			pending = ''
		}
	})
	child.stderr?.on('data', (chunk: Buffer) => {
		if (!spec.stderrLog) return
		try {
			mkdirSync(dirname(spec.stderrLog), { recursive: true, mode: 0o700 })
			let size = 0
			try {
				size = statSync(spec.stderrLog).size
			} catch {
				// first write
			}
			if (size < STDERR_CAP)
				appendFileSync(spec.stderrLog, chunk.subarray(0, STDERR_CAP - size), { mode: 0o600 })
		} catch {
			// stderr is best effort
		}
	})
	child.stdin?.on('error', () => {})
	return {
		get pid() {
			return child.pid
		},
		write: (line) => {
			child.stdin?.write(`${line}\n`)
		},
		endInput: () => {
			child.stdin?.end()
		},
		kill: (force) => {
			const pid = child.pid
			if (pid === undefined) return
			try {
				if (platform === 'win32') {
					if (force)
						execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
					else child.kill()
				} else process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
			} catch {
				try {
					child.kill(force ? 'SIGKILL' : 'SIGTERM')
				} catch {
					// already gone
				}
			}
		},
		onLine: (cb) => {
			lines.push(cb)
		},
		onExit: (cb) => {
			child.once('exit', (code, signal) => cb(code, signal))
			child.once('error', () => cb(1, null))
		},
	}
}

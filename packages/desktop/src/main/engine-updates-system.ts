import { execFile } from 'node:child_process'
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
	type EngineUpdateId,
	parseVersion,
	versionFromOutput,
} from '../shared/engine-update-protocol.js'
import { type EngineUpdateCache, emptyCache } from './engine-updates.js'

const VERSION_TIMEOUT_MS = 8_000
const REGISTRY_TIMEOUT_MS = 5_000
const MAX_REGISTRY_BYTES = 1024 * 1024
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** Characters Command Prompt reads as syntax inside a `/c` line. */
const CMD_SYNTAX = /[&|<>^%"!`\r\n\0]/u

export type ExecFileLike = (
	file: string,
	args: readonly string[],
	options: {
		timeout: number
		windowsHide: boolean
		windowsVerbatimArguments?: boolean
		env: NodeJS.ProcessEnv
		maxBuffer: number
	},
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown

/**
 * Runs `<program> --version` directly, with no shell of ours and no PowerShell: a `.cmd` shim goes
 * through Command Prompt on one fixed line, because Node refuses to start it any other way.
 */
export function versionRunner(options: {
	platform: NodeJS.Platform
	commandPrompt?: string
	env?: NodeJS.ProcessEnv
	run?: ExecFileLike
}): (program: { path: string; shim: boolean }) => Promise<string | undefined> {
	const run = options.run ?? (execFile as unknown as ExecFileLike)
	return (program) =>
		new Promise((resolve) => {
			const env = { ...(options.env ?? process.env) }
			// The app may itself run as Node; a program it starts must not inherit that.
			env.ELECTRON_RUN_AS_NODE = undefined
			const common = { timeout: VERSION_TIMEOUT_MS, windowsHide: true, env, maxBuffer: 64 * 1024 }
			const done = (error: Error | null, stdout: string, stderr: string) => {
				// A nonzero exit can still have printed the version, but a program that failed is not trusted.
				resolve(error ? undefined : versionFromOutput(`${stdout}\n${stderr}`))
			}
			try {
				if (options.platform === 'win32' && program.shim) {
					if (CMD_SYNTAX.test(program.path)) return resolve(undefined)
					run(
						options.commandPrompt ?? 'cmd.exe',
						['/d', '/s', '/c', `"${program.path}" --version`],
						{ ...common, windowsVerbatimArguments: true },
						done,
					)
				} else run(program.path, ['--version'], common, done)
			} catch {
				resolve(undefined)
			}
		})
}

/**
 * The registry base. An installed app takes an override only on this machine, as the update feed
 * does, so a poisoned environment cannot point the check at another host.
 */
export function registryBase(
	env: Record<string, string | undefined>,
	options: { packaged: boolean },
): string {
	const raw = env.NAMZU_ENGINE_REGISTRY
	if (!raw) return DEFAULT_REGISTRY
	try {
		const url = new URL(raw)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_REGISTRY
		if (options.packaged && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
			return DEFAULT_REGISTRY
		return url.href.replace(/\/+$/u, '')
	} catch {
		return DEFAULT_REGISTRY
	}
}

export type FetchLike = (
	url: string,
	init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; text(): Promise<string> }>

/** `GET <registry>/<package>/latest`, and only its `version` is read. Any failure is undefined. */
export function registryLatest(options: {
	base: string
	fetch: FetchLike
}): (pkg: string) => Promise<string | undefined> {
	return async (pkg) => {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)
		try {
			const response = await options.fetch(`${options.base}/${pkg}/latest`, {
				signal: controller.signal,
				headers: { accept: 'application/json' },
			})
			if (!response.ok) return undefined
			const text = await response.text()
			if (text.length > MAX_REGISTRY_BYTES) return undefined
			const parsed: unknown = JSON.parse(text)
			if (!parsed || typeof parsed !== 'object') return undefined
			const version = (parsed as { version?: unknown }).version
			// `latest` is a release; an alpha in its place is not an update to offer.
			return typeof version === 'string' &&
				/^\d+\.\d+\.\d+$/u.test(version) &&
				parseVersion(version)
				? version
				: undefined
		} catch {
			return undefined
		} finally {
			clearTimeout(timer)
		}
	}
}

/** The first bytes of a small script file, for reading which package an npm shim starts. */
export function shimTextOf(path: string): string | undefined {
	try {
		const fd = openSync(path, 'r')
		try {
			const buffer = Buffer.alloc(4096)
			const read = readSync(fd, buffer, 0, buffer.length, 0)
			return buffer.subarray(0, read).toString('utf8')
		} finally {
			closeSync(fd)
		}
	} catch {
		return undefined
	}
}

export function realPathOf(path: string): string | undefined {
	try {
		return realpathSync(path)
	} catch {
		return undefined
	}
}

/** The last registry answers and announced versions, in the app's own folder. */
export function engineUpdateCacheFile(file: string, onError?: (error: unknown) => void) {
	return {
		read(): EngineUpdateCache {
			try {
				const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
				if (!parsed || typeof parsed !== 'object') return emptyCache()
				const value = parsed as { version?: unknown; latest?: unknown; announced?: unknown }
				if (value.version !== 1) return emptyCache()
				const cache = emptyCache()
				const ids: EngineUpdateId[] = ['codex-cli', 'claude-code', 'namzu-cli']
				const latest = (value.latest ?? {}) as Record<string, unknown>
				const announced = (value.announced ?? {}) as Record<string, unknown>
				for (const id of ids) {
					const entry = latest[id] as { version?: unknown; checkedAt?: unknown } | undefined
					if (
						entry &&
						typeof entry.version === 'string' &&
						parseVersion(entry.version) &&
						typeof entry.checkedAt === 'number' &&
						Number.isFinite(entry.checkedAt)
					)
						cache.latest[id] = { version: entry.version, checkedAt: entry.checkedAt }
					const seen = announced[id]
					if (typeof seen === 'string' && parseVersion(seen)) cache.announced[id] = seen
				}
				return cache
			} catch {
				// Missing or foreign: the next check writes a fresh one.
				return emptyCache()
			}
		},
		write(cache: EngineUpdateCache): void {
			const temporary = `${file}.${process.pid}.tmp`
			try {
				mkdirSync(dirname(file), { recursive: true })
				writeFileSync(temporary, JSON.stringify({ version: 1, ...cache }), { mode: 0o600 })
				renameSync(temporary, file)
			} catch (error) {
				try {
					unlinkSync(temporary)
				} catch {
					/* Nothing was written. */
				}
				onError?.(error)
			}
		},
	}
}

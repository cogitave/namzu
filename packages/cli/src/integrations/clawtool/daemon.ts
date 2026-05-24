/**
 * `ensureDaemon` — TS port of clawtool's Go `daemon.Ensure(ctx)`.
 *
 * Contract:
 *   1. Read the state file. If healthy (`/v1/health` returns 200), return
 *      its endpoint + token verbatim.
 *   2. If missing OR unhealthy, spawn `clawtool daemon start` (detached,
 *      `cmd.unref()`), wait briefly for the state file + listener, then
 *      re-probe. Return on success or throw with the underlying reason.
 *
 * The spawn path requires `findBinary` to return a real executable. If
 * `autoStart` is disabled in config and the daemon isn't running, throw
 * without spawning — surface "daemon not running" to the user instead.
 */

import { spawn } from 'node:child_process'

import { tryReadToken } from './auth.js'
import { ClawtoolBinaryError, findBinary } from './binary.js'
import { readDaemonState } from './state.js'
import type { DaemonEndpoint } from './types.js'

export class ClawtoolDaemonError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message)
		this.name = 'ClawtoolDaemonError'
	}
}

export interface EnsureDaemonOptions {
	/** Disable auto-spawn (config: `clawtool.autoStart: false`). Default: true. */
	readonly autoStart?: boolean
	/** Override binary path (config: `clawtool.binary`). */
	readonly binary?: string
	/** Override endpoint base URL (config: `clawtool.endpoint`). */
	readonly endpoint?: string
	/** Override token (config: `clawtool.token`). */
	readonly token?: string
	/** Total deadline for the spawn → ready transition, default 10s. */
	readonly readyTimeoutMs?: number
	/** Poll interval while waiting for health, default 200ms. */
	readonly pollIntervalMs?: number
	/** Inject `fetch` for tests. */
	readonly fetch?: typeof fetch
}

const DEFAULT_READY_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 200

export async function ensureDaemon(opts: EnsureDaemonOptions = {}): Promise<DaemonEndpoint> {
	const fetchFn = opts.fetch ?? globalThis.fetch
	const autoStart = opts.autoStart ?? true

	// 1. If the user supplied both endpoint and token, trust them — no
	//    discovery, no spawn. Power-user escape hatch (e.g. remote daemon
	//    or test harness). An explicit empty-string token is honored so
	//    callers can address a `--no-auth` remote daemon without needing
	//    a synthetic placeholder; only `undefined` triggers discovery.
	if (opts.endpoint !== undefined && opts.token !== undefined) {
		return { baseUrl: normalizeUrl(opts.endpoint), token: opts.token }
	}

	// 2. Try state file first.
	const fromState = await tryStateEndpoint(opts, fetchFn)
	if (fromState) return fromState

	// 3. Auto-spawn if allowed.
	if (!autoStart) {
		throw new ClawtoolDaemonError(
			'clawtool daemon is not running and `clawtool.autoStart` is disabled — start it manually with `clawtool daemon start`',
		)
	}
	await spawnDaemon(opts)

	// 4. Poll for readiness.
	const deadline = Date.now() + (opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
	const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
	while (Date.now() < deadline) {
		await sleep(interval)
		const ready = await tryStateEndpoint(opts, fetchFn)
		if (ready) return ready
	}
	throw new ClawtoolDaemonError(
		`clawtool daemon did not become ready within ${opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms after spawn`,
	)
}

async function tryStateEndpoint(
	opts: EnsureDaemonOptions,
	fetchFn: typeof fetch,
): Promise<DaemonEndpoint | null> {
	const state = readDaemonState()
	if (!state) return null
	const baseUrl = normalizeUrl(opts.endpoint ?? `http://127.0.0.1:${state.port}`)
	if (!(await isHealthy(baseUrl, fetchFn))) return null
	// Token is optional. The locally-managed daemon (`clawtool daemon start`)
	// runs with `--no-auth` and writes no token file; bearer-mode tokens
	// only appear when the user runs `clawtool serve` themselves. Empty
	// token signals the MCP client to skip the Authorization header.
	const token = opts.token ?? tryReadToken(state.token_file) ?? ''
	return { baseUrl, token }
}

async function isHealthy(baseUrl: string, fetchFn: typeof fetch): Promise<boolean> {
	try {
		const res = await fetchFn(`${baseUrl}/v1/health`, { method: 'GET' })
		return res.ok
	} catch {
		return false
	}
}

async function spawnDaemon(opts: EnsureDaemonOptions): Promise<void> {
	let binary: string
	try {
		binary = findBinary({ override: opts.binary })
	} catch (err) {
		if (err instanceof ClawtoolBinaryError) {
			throw new ClawtoolDaemonError(err.message, err)
		}
		throw err
	}
	const child = spawn(binary, ['daemon', 'start'], {
		stdio: 'ignore',
		detached: true,
	})
	child.on('error', (err) => {
		throw new ClawtoolDaemonError(`failed to spawn ${binary}: ${err.message}`, err)
	})
	child.unref()
}

function normalizeUrl(u: string): string {
	return u.replace(/\/$/, '')
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

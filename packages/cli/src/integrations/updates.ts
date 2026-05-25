/**
 * Update checks for namzu (npm) and clawtool (`clawtool upgrade --check`),
 * surfaced in the TUI so the user knows when a newer version is out. Both are
 * best-effort with short timeouts: offline / unpublished / no-clawtool just
 * yields `null`, never an error or a hang.
 */

import { execFile } from 'node:child_process'

import { findBinary } from './clawtool/binary.js'

export interface UpdateInfo {
	readonly name: string
	readonly current: string
	readonly latest: string
	/** How to upgrade, shown to the user. */
	readonly how: string
}

const NPM_TIMEOUT_MS = 2_500
const CLAWTOOL_TIMEOUT_MS = 5_000

/** Compare dotted numeric versions; >0 if a>b, <0 if a<b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) =>
		v
			.replace(/^v/, '')
			.split('-')[0] // drop pre-release suffix
			?.split('.')
			.map((n) => Number.parseInt(n, 10) || 0) ?? []
	const pa = parse(a)
	const pb = parse(b)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0)
		if (d !== 0) return d
	}
	return 0
}

/** Newer @namzu/cli on npm, or null when up to date / unreachable. */
export async function checkNamzuUpdate(current: string): Promise<UpdateInfo | null> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), NPM_TIMEOUT_MS)
	try {
		const res = await fetch('https://registry.npmjs.org/@namzu/cli/latest', {
			signal: controller.signal,
			headers: { accept: 'application/json' },
		})
		if (!res.ok) return null
		const data = (await res.json()) as { version?: unknown }
		const latest = typeof data.version === 'string' ? data.version : null
		if (!latest || compareVersions(latest, current) <= 0) return null
		return { name: 'namzu', current, latest, how: 'npm i -g @namzu/cli' }
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}

function run(bin: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout: CLAWTOOL_TIMEOUT_MS }, (_err, stdout) => resolve(stdout ?? ''))
	})
}

/**
 * Newer clawtool, or null. Prefers the machine-readable
 * `upgrade --check --json` (newer binaries); falls back to parsing the
 * `current -> latest` line in the plain `upgrade --check` output (older
 * binaries that predate `--json`).
 */
export async function checkClawtoolUpdate(): Promise<UpdateInfo | null> {
	let bin: string
	try {
		bin = findBinary()
	} catch {
		return null
	}
	const how = 'clawtool upgrade'

	// JSON path (preferred).
	try {
		const data = JSON.parse(await run(bin, ['upgrade', '--check', '--json'])) as {
			current?: string
			latest?: string
			update_available?: boolean
		}
		if (data.update_available && data.current && data.latest) {
			return { name: 'clawtool', current: data.current, latest: data.latest, how }
		}
		if (data.current) return null // valid JSON, no update
	} catch {
		// fall through to plain parsing
	}

	// Plain-output fallback: a line like `0.22.159 -> 0.22.160`.
	const plain = await run(bin, ['upgrade', '--check'])
	const m = plain.match(/(\d+\.\d+\.\d+)\s*->\s*(\d+\.\d+\.\d+)/)
	if (m?.[1] && m[2] && compareVersions(m[2], m[1]) > 0) {
		return { name: 'clawtool', current: m[1], latest: m[2], how }
	}
	return null
}

/** Run both checks in parallel; returns whichever have an update available. */
export async function checkUpdates(namzuVersion: string): Promise<readonly UpdateInfo[]> {
	const [namzu, clawtool] = await Promise.all([
		checkNamzuUpdate(namzuVersion),
		checkClawtoolUpdate(),
	])
	return [namzu, clawtool].filter((u): u is UpdateInfo => u !== null)
}

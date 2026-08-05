/**
 * Update check for namzu (npm),
 * surfaced in the TUI so the user knows when a newer version is out. Both are
 * best-effort with short timeouts: offline or unpublished just
 * yields `null`, never an error or a hang.
 */

import { execFile } from 'node:child_process'

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


/** Returns an update when one is available. */
export async function checkUpdates(namzuVersion: string): Promise<readonly UpdateInfo[]> {
	const namzu = await checkNamzuUpdate(namzuVersion)
	return namzu ? [namzu] : []
}

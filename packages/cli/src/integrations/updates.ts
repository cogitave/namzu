/**
 * Update check for namzu (npm), surfaced in the TUI so the user knows when a
 * newer version is out. Best-effort with a short timeout: offline or
 * unpublished yields `null`, never an error or a hang.
 */

export interface UpdateInfo {
	readonly name: string
	readonly current: string
	readonly latest: string
	/** How to upgrade, shown to the user. */
	readonly how: string
}

const NPM_TIMEOUT_MS = 2_500

const SEMVER_PATTERN =
	/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

interface ParsedVersion {
	readonly core: readonly [number, number, number]
	readonly prerelease: readonly string[] | null
}

/**
 * Settle an opaque async operation when this caller's authority expires.
 *
 * Passing a signal to `fetch` is a cancellation request, not a settlement
 * guarantee: an injected transport or response body may ignore it forever.
 * The update check is advertised as best-effort and bounded, so its own
 * promise has to race the boundary as well.
 */
async function withSignal<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted()
	let rejectAbort: ((reason: unknown) => void) | undefined
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const onAbort = () => rejectAbort?.(signal.reason)
	signal.addEventListener('abort', onAbort, { once: true })
	try {
		return await Promise.race([operation, aborted])
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}

function parseVersion(value: string): ParsedVersion | null {
	const match = SEMVER_PATTERN.exec(value)
	if (!match) return null
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4]?.split('.') ?? null,
	}
}

/** Compare semantic versions; >0 if a>b, <0 if a<b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a)
	const pb = parseVersion(b)
	if (!pa || !pb) throw new Error(`Cannot compare invalid semantic versions: ${a}, ${b}`)
	for (let i = 0; i < pa.core.length; i++) {
		const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0)
		if (d !== 0) return d
	}
	if (pa.prerelease === null || pb.prerelease === null) {
		if (pa.prerelease === pb.prerelease) return 0
		return pa.prerelease === null ? 1 : -1
	}
	for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i++) {
		const left = pa.prerelease[i]
		const right = pb.prerelease[i]
		if (left === right) continue
		if (left === undefined) return -1
		if (right === undefined) return 1
		const leftNumeric = /^\d+$/.test(left)
		const rightNumeric = /^\d+$/.test(right)
		if (leftNumeric && rightNumeric) return Number(left) - Number(right)
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
		return left < right ? -1 : 1
	}
	return 0
}

export interface LatestNamzuVersionOptions {
	readonly fetch?: typeof fetch
	readonly timeoutMs?: number
}

/** Exact latest published CLI version, or an error when it cannot be established. */
export async function latestNamzuVersion(options: LatestNamzuVersionOptions = {}): Promise<string> {
	const controller = new AbortController()
	const timeoutMs = options.timeoutMs ?? NPM_TIMEOUT_MS
	const timeout = Object.assign(
		new Error(`npm registry update check timed out after ${timeoutMs}ms`),
		{ name: 'TimeoutError' },
	)
	const timer = setTimeout(() => controller.abort(timeout), timeoutMs)
	try {
		const res = await withSignal(
			(options.fetch ?? fetch)('https://registry.npmjs.org/@namzu/cli/latest', {
				signal: controller.signal,
				headers: { accept: 'application/json' },
			}),
			controller.signal,
		)
		if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status}`)
		const data = (await withSignal(res.json(), controller.signal)) as { version?: unknown }
		if (typeof data.version !== 'string' || parseVersion(data.version) === null) {
			throw new Error('npm registry returned an invalid @namzu/cli version')
		}
		return data.version.replace(/^v/, '')
	} finally {
		clearTimeout(timer)
	}
}

/** Newer @namzu/cli on npm, or null when up to date / unreachable. */
export async function checkNamzuUpdate(current: string): Promise<UpdateInfo | null> {
	try {
		const latest = await latestNamzuVersion()
		if (compareVersions(latest, current) <= 0) return null
		return { name: 'namzu', current, latest, how: 'namzu upgrade' }
	} catch {
		return null
	}
}

/** Returns an update when one is available. */
export async function checkUpdates(namzuVersion: string): Promise<readonly UpdateInfo[]> {
	const namzu = await checkNamzuUpdate(namzuVersion)
	return namzu ? [namzu] : []
}

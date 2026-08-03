/**
 * Path arithmetic in the SANDBOX's coordinate system.
 *
 * A sandbox is a POSIX filesystem whatever the host runs, so resolving its
 * paths with the host's path module rewrites them whenever the two
 * disagree: on a Windows host, `resolve('/workspace')` becomes
 * `C:\workspace` and a container path stops being a container path. The
 * tool then hands the model a string its own sandbox cannot open — which
 * is the same class of failure as reporting host-relative paths from a
 * sandboxed search, just one layer lower.
 *
 * These are deliberately small: join, relativise, and refuse an escape.
 * Nothing here touches the host filesystem.
 */

function normalizeSegments(path: string): string[] {
	const out: string[] = []
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') {
			// Popping past the root is how a climb-out starts; the caller
			// decides what to do about it via `resolveWithinPosix`.
			if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
			else out.push('..')
			continue
		}
		out.push(segment)
	}
	return out
}

/** Join, normalising `.` and `..`. Absolute in, absolute out. */
export function joinPosix(base: string, ...parts: string[]): string {
	const absolute = base.startsWith('/')
	const segments = normalizeSegments([base, ...parts].join('/'))
	return (absolute ? '/' : '') + segments.join('/')
}

/** `to` expressed relative to `from`, or `to` itself when unrelated. */
export function relativePosix(from: string, to: string): string {
	const fromSegments = normalizeSegments(from)
	const toSegments = normalizeSegments(to)

	let shared = 0
	while (
		shared < fromSegments.length &&
		shared < toSegments.length &&
		fromSegments[shared] === toSegments[shared]
	) {
		shared++
	}

	const up = fromSegments.slice(shared).map(() => '..')
	return [...up, ...toSegments.slice(shared)].join('/')
}

/**
 * Resolve `candidate` against `root`, refusing anything that lands
 * outside. The sandbox-side twin of the host containment check.
 */
export function resolveWithinPosix(root: string, candidate: string | undefined): string {
	if (candidate === undefined || candidate === '') return joinPosix(root)

	// An absolute candidate is taken as sandbox-absolute, not appended.
	const resolved = candidate.startsWith('/') ? joinPosix(candidate) : joinPosix(root, candidate)
	const rel = relativePosix(root, resolved)
	if (rel.startsWith('..')) {
		throw new Error(
			`Path escapes the working directory: ${candidate}. Tools may only reach inside ${root}.`,
		)
	}
	return resolved
}

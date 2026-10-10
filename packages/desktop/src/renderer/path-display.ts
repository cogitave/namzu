/**
 * Paths as a person reads them: inside the project, the part after the project's folder; elsewhere,
 * with the home folder written as `~` and a long middle replaced by an ellipsis. The full path
 * belongs in a tooltip, never in the sentence.
 */

const WINDOWS_DRIVE = /^[A-Za-z]:/

function slashes(path: string): string {
	return path.replace(/\\/g, '/')
}

function caseless(path: string): boolean {
	return WINDOWS_DRIVE.test(path) || path.startsWith('//')
}

/** The path below `root` when it lies inside it, with forward slashes; otherwise `undefined`. */
export function projectRelative(path: string, root?: string): string | undefined {
	if (!root) return undefined
	const target = slashes(path).replace(/\/+$/, '')
	const base = slashes(root).replace(/\/+$/, '')
	if (!base) return undefined
	const fold = caseless(base)
	const a = fold ? target.toLowerCase() : target
	const b = fold ? base.toLowerCase() : base
	if (a === b) return '.'
	return a.startsWith(`${b}/`) ? target.slice(base.length + 1) : undefined
}

/** The home folder as `~`, recognised from the path alone (the screen does not know whose it is). */
export function tildePath(path: string): string {
	const text = slashes(path)
	const home = /^(?:\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/.exec(text)
	return home ? `~${text.slice(home[0].length)}` : text
}

/** Keeps the start and the end of a long path and replaces the middle with an ellipsis. */
export function middleEllipsis(text: string, max = 48): string {
	const chars = Array.from(text)
	if (chars.length <= max) return text
	const keepEnd = Math.ceil((max - 1) * 0.6)
	const keepStart = max - 1 - keepEnd
	return `${chars.slice(0, keepStart).join('')}…${chars.slice(chars.length - keepEnd).join('')}`
}

/** A path for a sentence or a row: project-relative when it can be, else `~`-shortened, then cut. */
export function displayPath(path: string, root?: string, max = 48): string {
	const relative = projectRelative(path, root)
	if (relative !== undefined)
		return middleEllipsis(relative === '.' ? 'the project folder' : relative, max)
	return middleEllipsis(tildePath(path), max)
}

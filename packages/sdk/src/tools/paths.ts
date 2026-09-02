import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Resolve a caller-supplied path against a root, refusing anything that
 * lands outside it.
 *
 * The containment rule existed, in one private function inside the local
 * sandbox provider, and the filesystem tools never reached it. They called
 * `resolve(workingDirectory, input.path)` bare — so `path: "../../.."`
 * resolved to whatever is above the working directory and the tool read it
 * happily. That holds with no sandbox configured at all, which is the
 * common case, so the escape did not need a misconfiguration to reach: a
 * model that asks for a parent directory gets one.
 *
 * `relative()` rather than a `startsWith` prefix test: a prefix test says
 * `/workspace-backup` is inside `/workspace`, and the whole point is to be
 * exact about the boundary.
 */
export function resolveWithin(root: string, candidate: string | undefined): string {
	if (candidate === undefined || candidate === '') return resolve(root)

	const resolvedRoot = resolve(root)
	const resolved = resolve(resolvedRoot, candidate)
	const rel = relative(resolvedRoot, resolved)

	// An absolute `rel` means the two paths share no root at all (a
	// different drive on Windows); a leading `..` means it climbed out.
	if (rel.startsWith('..') || isAbsolute(rel)) {
		throw new Error(
			`Path escapes the working directory: ${candidate}. Tools may only reach inside ${resolvedRoot}.`,
		)
	}
	return resolved
}

/** True when `candidate` resolves inside `root`. */
/**
 * The directories a tool may reach: the working directory first, then any
 * the host added for the session (`/add-dir`). Relative paths resolve
 * against the first; an absolute path is accepted inside any.
 */
export function toolRoots(context: {
	readonly workingDirectory: string
	readonly additionalDirectories?: readonly string[]
}): readonly string[] {
	return [context.workingDirectory, ...(context.additionalDirectories ?? [])]
}

function describeRoots(roots: readonly string[]): string {
	return roots.length === 1
		? `inside ${resolve(roots[0] as string)}`
		: `inside ${resolve(roots[0] as string)} or the added directories ${roots
				.slice(1)
				.map((r) => resolve(r))
				.join(', ')}`
}

/** `resolveWithin` over several roots. See `toolRoots` for the order. */
export function resolveWithinAny(roots: readonly string[], candidate: string | undefined): string {
	const [first, ...rest] = roots
	if (first === undefined) throw new Error('No root to resolve within.')
	if (rest.length === 0) return resolveWithin(first, candidate)
	const resolved =
		candidate === undefined || candidate === ''
			? resolve(first)
			: resolve(resolve(first), candidate)
	for (const root of roots) {
		if (isWithin(root, resolved)) return resolveWithin(root, resolved)
	}
	throw new Error(
		`Path escapes the working directory: ${candidate}. Tools may only reach ${describeRoots(roots)}.`,
	)
}

/** `resolveWithinReal` over several roots: the first that contains the path, links followed. */
export async function resolveWithinAnyReal(
	roots: readonly string[],
	candidate: string | undefined,
): Promise<string> {
	const [first, ...rest] = roots
	if (first === undefined) throw new Error('No root to resolve within.')
	if (rest.length === 0) return resolveWithinReal(first, candidate)
	const resolved =
		candidate === undefined || candidate === ''
			? resolve(first)
			: resolve(resolve(first), candidate)
	let firstError: unknown
	for (const root of roots) {
		try {
			return await resolveWithinReal(root, resolved)
		} catch (err) {
			firstError ??= err
		}
	}
	throw new Error(
		`Path escapes the working directory: ${candidate}. Tools may only reach ${describeRoots(roots)}.`,
		{ cause: firstError },
	)
}

export function isWithin(root: string, candidate: string): boolean {
	try {
		resolveWithin(root, candidate)
		return true
	} catch {
		return false
	}
}

/**
 * The same containment rule, decided after symlinks are resolved.
 *
 * {@link resolveWithin} is lexical, and a lexical check is not a boundary for
 * a tool that then follows links. `./notes -> /etc` passes it, because
 * `./notes/passwd` climbs nothing on paper; the write lands in `/etc`. That is
 * CWE-59, *Improper Link Resolution Before File Access*, and the mitigation
 * CWE-22 states for the family is the ordering this function exists to get
 * right: canonicalize first, validate the canonical form, never the input.
 *
 * `atomicWriteFile` makes the ordering load-bearing rather than theoretical.
 * It resolves the destination and writes THROUGH a link on purpose — so that
 * editing a linked file updates the target instead of replacing the link with
 * a regular file — which is correct behaviour and, paired with a lexical
 * check, is check-then-follow.
 *
 * Three things this has to get right that a single `realpath` does not:
 *
 * 1. **The root can itself be a symlink.** `os.tmpdir()` is one on macOS
 *    (`/var/folders/…` under `/private`). Canonicalizing only the candidate
 *    and comparing against a raw root rejects every path in a temp directory —
 *    a containment check that refuses everything is not safer, it is broken,
 *    and it fails in exactly the environment tests run in.
 * 2. **The target may not exist.** `write` creates files, and `realpath` on a
 *    missing path throws. So this canonicalizes the deepest ancestor that DOES
 *    exist and appends the rest lexically. The remainder cannot hide a link,
 *    because nothing is there to be one.
 * 3. **The lexical check still runs first.** It costs nothing, refuses the
 *    common `../../..` before touching the filesystem, and its message names
 *    the offending input — which the canonical comparison, working on two
 *    absolute paths, cannot.
 *
 * What this does NOT give you is TOCTOU safety. A component swapped for a
 * symlink between this check and the open would still be followed; closing
 * that needs per-component `openat`/`O_NOFOLLOW`, which Node does not expose.
 * The threat here is a link that is already there — a repository that contains
 * one, or one an earlier tool call created — not an attacker racing the
 * process on the user's own machine.
 */
export async function resolveWithinReal(
	root: string,
	candidate: string | undefined,
): Promise<string> {
	// Cheap, and the only step that can name the caller's input in its error.
	const lexical = resolveWithin(root, candidate)

	const realRoot = await realpath(root).catch(() => resolve(root))

	// Walk up to the deepest existing ancestor. Terminates at the filesystem
	// root, where `dirname` becomes a fixed point.
	let existing = lexical
	let remainder = ''
	for (;;) {
		const found = await realpath(existing).then(
			(value) => value,
			() => undefined,
		)
		if (found !== undefined) {
			existing = found
			break
		}
		const parent = dirname(existing)
		if (parent === existing) {
			// Nothing on this branch exists at all, so there is no link to
			// follow and the lexical answer is already the canonical one.
			return lexical
		}
		remainder = remainder ? join(basename(existing), remainder) : basename(existing)
		existing = parent
	}

	const rel = relative(realRoot, existing)
	if (rel.startsWith('..') || isAbsolute(rel)) {
		throw new Error(
			`Path escapes the working directory: ${candidate}. It resolves through a link to ${existing}, outside ${realRoot}.`,
		)
	}

	return remainder ? join(existing, remainder) : existing
}

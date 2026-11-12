/**
 * Versions of the command line, compared by the SemVer 2.0 precedence rules.
 *
 * The comparison in `shared/engine-update-protocol.ts` orders prerelease tags as plain
 * strings, so `1.0.0-rc.10` sorts before `1.0.0-rc.2` and a numeric tag is not told from a
 * word. A version here decides which folder runs, so it is read strictly and compared by the
 * book. A version is also a folder name, so build metadata (`+...`) is not accepted at all.
 */

const NUMERIC = '(?:0|[1-9]\\d*)'
const IDENTIFIER = `(?:${NUMERIC}|\\d*[A-Za-z-][0-9A-Za-z-]*)`
const VERSION = new RegExp(
	`^(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`,
	'u',
)

export const MAX_VERSION_LENGTH = 64

export interface ParsedVersion {
	major: number
	minor: number
	patch: number
	prerelease: string[]
}

export function parseKernelVersion(text: unknown): ParsedVersion | undefined {
	if (typeof text !== 'string' || text.length > MAX_VERSION_LENGTH) return undefined
	const match = VERSION.exec(text)
	if (!match) return undefined
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] === undefined ? [] : match[4].split('.'),
	}
}

export function isKernelVersion(text: unknown): text is string {
	return parseKernelVersion(text) !== undefined
}

function compareIdentifiers(a: string, b: string): number {
	const aNumeric = /^\d+$/u.test(a)
	const bNumeric = /^\d+$/u.test(b)
	if (aNumeric && bNumeric) {
		// Compared as numbers of any length: by digit count, then digit by digit.
		if (a.length !== b.length) return a.length < b.length ? -1 : 1
		return a === b ? 0 : a < b ? -1 : 1
	}
	if (aNumeric) return -1
	if (bNumeric) return 1
	return a === b ? 0 : a < b ? -1 : 1
}

/** -1, 0 or 1. Throws on a text that is not a version: callers read versions strictly first. */
export function compareKernelVersions(a: string, b: string): -1 | 0 | 1 {
	const left = parseKernelVersion(a)
	const right = parseKernelVersion(b)
	if (!left || !right) throw new TypeError(`Not a command line version: ${left ? b : a}`)
	for (const key of ['major', 'minor', 'patch'] as const) {
		if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
	}
	if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
	if (left.prerelease.length === 0) return 1
	if (right.prerelease.length === 0) return -1
	const shared = Math.min(left.prerelease.length, right.prerelease.length)
	for (let index = 0; index < shared; index++) {
		const result = compareIdentifiers(
			left.prerelease[index] as string,
			right.prerelease[index] as string,
		)
		if (result !== 0) return result < 0 ? -1 : 1
	}
	if (left.prerelease.length === right.prerelease.length) return 0
	return left.prerelease.length < right.prerelease.length ? -1 : 1
}

export function isNewerKernelVersion(candidate: string, than: string): boolean {
	return compareKernelVersions(candidate, than) > 0
}

import type { PluginManifest } from '../types/plugin/index.js'

/**
 * Whether a plugin can run on this machine and this runtime, decided from what
 * its manifest declares. A manifest that declares nothing is compatible with
 * everything, so every plugin written before these fields existed loads as it did.
 */

type Triple = readonly [number, number, number]

const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+].*)?$/i

function parseVersion(text: string): Triple | undefined {
	const match = VERSION_PATTERN.exec(text.trim())
	if (!match) return undefined
	const part = (value: string | undefined): number => (value === undefined ? 0 : Number(value))
	return [Number(match[1]), part(match[2]), part(match[3])]
}

function compare(a: Triple, b: Triple): number {
	for (let i = 0; i < 3; i++) {
		const diff = (a[i] as number) - (b[i] as number)
		if (diff !== 0) return diff
	}
	return 0
}

/** One comparator such as `>=1.2.0`, `^2`, `~1.4` or `3.1.0`; undefined when unreadable. */
function satisfiesComparator(version: Triple, token: string): boolean | undefined {
	const op = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token)
	if (!op) return undefined
	const operator = op[1] ?? '='
	const target = parseVersion(op[2] as string)
	if (!target) return undefined
	const order = compare(version, target)
	switch (operator) {
		case '>=':
			return order >= 0
		case '<=':
			return order <= 0
		case '>':
			return order > 0
		case '<':
			return order < 0
		case '^': {
			// Compatible with the left-most non-zero part.
			const upper: Triple =
				target[0] > 0
					? [target[0] + 1, 0, 0]
					: target[1] > 0
						? [0, target[1] + 1, 0]
						: [0, 0, target[2] + 1]
			return order >= 0 && compare(version, upper) < 0
		}
		case '~':
			return order >= 0 && compare(version, [target[0], target[1] + 1, 0]) < 0
		default: {
			// A bare `1` or `1.4` names a whole major or minor.
			const written = (op[2] as string).replace(/^v/i, '').split(/[-+]/)[0] as string
			const parts = written.split('.').filter((p) => p !== 'x' && p !== '*')
			return parts.every((p, i) => Number(p) === version[i])
		}
	}
}

/**
 * Whether `version` satisfies `range`. Supports space-separated comparators
 * that must all hold, `||` between alternatives, and the operators `>=`, `>`,
 * `<=`, `<`, `=`, `^` and `~`. Returns undefined when the range cannot be read.
 */
export function versionSatisfies(versionText: string, range: string): boolean | undefined {
	const version = parseVersion(versionText)
	if (!version) return undefined
	let readable = true
	let any = false
	for (const alternative of range.split('||')) {
		// Join an operator written apart from its number (">= 1.2") first.
		const tokens = alternative
			.trim()
			.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
			.split(/\s+/)
			.filter(Boolean)
		if (tokens.length === 0) {
			readable = false
			continue
		}
		let all = true
		for (const token of tokens) {
			const ok = satisfiesComparator(version, token)
			if (ok === undefined) {
				readable = false
				all = false
				break
			}
			if (!ok) all = false
		}
		if (all) any = true
	}
	if (any) return true
	return readable ? false : undefined
}

export interface PluginHostFacts {
	/** The operating system, as `process.platform` names it. Default: this process. */
	readonly platform?: string
	/** The Namzu runtime version. Default: this package's own version. */
	readonly namzuVersion?: string
}

/**
 * Refuse a plugin that declares it does not support this platform or this
 * Namzu version. The reason names the plugin, what it declares and what this
 * machine is, so a person can act on it without reading the manifest.
 *
 * A runtime whose own version is unknown (`0.0.0`, the placeholder a bundle
 * reports when it cannot read its package file) is not held against the range:
 * refusing every plugin on a guess would be worse than admitting one.
 */
export function assertCompatible(manifest: PluginManifest, host: Required<PluginHostFacts>): void {
	const platforms = manifest.platforms
	if (platforms && platforms.length > 0 && !platforms.includes(host.platform)) {
		throw new Error(
			`Plugin "${manifest.name}" supports only ${platforms.join(', ')}, and this machine runs ${host.platform}, so it was not loaded.`,
		)
	}
	const range = manifest.engines?.namzu
	if (range === undefined || host.namzuVersion === '0.0.0') return
	const ok = versionSatisfies(host.namzuVersion, range)
	if (ok === undefined) {
		throw new Error(
			`Plugin "${manifest.name}" declares the Namzu version range "${range}", which cannot be read, so it was not loaded. Write it like ">=60.0.0" or "^60.1.0".`,
		)
	}
	if (!ok) {
		throw new Error(
			`Plugin "${manifest.name}" needs Namzu ${range}, and this is Namzu ${host.namzuVersion}, so it was not loaded. Update Namzu or use a plugin version made for this one.`,
		)
	}
}

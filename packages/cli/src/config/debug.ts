/**
 * Values-free configuration provenance for the interactive debug surface.
 *
 * `NamzuCliConfig` can carry command arguments, destinations and permission
 * patterns. None belongs in a terminal diagnostic merely because the loader
 * knows it. This snapshot therefore has no slot for a value: it keeps only the
 * top-level key and the source that won.
 */

import { LOG_SECRET_PATTERNS } from '@namzu/sdk'

import type { ConfigProvenance, ConfigSource } from './load.js'
import type { NamzuCliConfig } from './schema.js'

export type EffectiveConfigSource =
	| ConfigSource
	| { readonly kind: 'cli-flag'; readonly flag: '--format' | '--quiet' }

export type EffectiveConfigProvenance = {
	readonly [K in keyof NamzuCliConfig]?: EffectiveConfigSource
}

export interface ConfigDebugSnapshot {
	/** One entry per resolved top-level key; config values cannot inhabit this type. */
	readonly sources: EffectiveConfigProvenance
	/** Kept even if environment/managed config wins every key the profile set. */
	readonly selectedProfile?: {
		readonly name: string
		readonly selectedBy: '--profile' | 'NAMZU_PROFILE'
	}
}

export interface ConfigDebugSnapshotOptions {
	/** The CLI flag was valid and replaced the loaded `format` value. */
	readonly formatFromCli?: boolean
	/** `--quiet` replaced the loaded `quiet` value. */
	readonly quietFromCli?: boolean
	readonly selectedProfile?: ConfigDebugSnapshot['selectedProfile']
}

/**
 * Copy launch-time provenance and apply the two CLI value overrides.
 *
 * Booleans rather than the flag values themselves are deliberate: a config
 * value cannot leak through an API that never accepts one.
 */
export function createConfigDebugSnapshot(
	provenance: ConfigProvenance,
	options: ConfigDebugSnapshotOptions = {},
): ConfigDebugSnapshot {
	const sources: { -readonly [K in keyof NamzuCliConfig]?: EffectiveConfigSource } = {
		...provenance,
	}
	if (options.formatFromCli) sources.format = { kind: 'cli-flag', flag: '--format' }
	if (options.quietFromCli) sources.quiet = { kind: 'cli-flag', flag: '--quiet' }

	const selectedProfile = options.selectedProfile
		? Object.freeze({ ...options.selectedProfile })
		: undefined
	return Object.freeze({
		sources: Object.freeze(sources),
		...(selectedProfile ? { selectedProfile } : {}),
	})
}

/** One formatter for boot logs and operator diagnostics. */
export function formatConfigSource(
	source: ConfigSource,
	dynamic: (value: string) => string = (value) => value,
): string {
	switch (source.kind) {
		case 'default':
			return 'default'
		case 'user-file':
			return `user-file ${dynamic(source.path)}`
		case 'project-file':
			return `project-file ${dynamic(source.path)}`
		case 'profile':
			// The name AND the file. Neither answers on its own: the name does
			// not say which file to open, and the path does not say which of
			// that file's profiles is in force.
			return `profile ${dynamic(source.name)} (${dynamic(source.path)})`
		case 'env':
			return `env ${dynamic(source.variable)}`
		case 'managed':
			return `managed ${dynamic(source.path)}`
	}
}

/** Render the source snapshot without ever receiving a resolved config value. */
export function renderConfigDebug(snapshot: ConfigDebugSnapshot | null): string {
	if (!snapshot) {
		return [
			'Configuration provenance is unavailable in this embedded TUI.',
			'Restart through the namzu CLI to inspect launch-time sources.',
		].join('\n')
	}

	const lines = [
		'Configuration precedence (low -> high):',
		'  default -> user file -> project file -> selected profile(s) -> environment -> managed file',
		'  --format and --quiet override only their matching keys for this process.',
	]

	if (snapshot.selectedProfile) {
		lines.push(
			'',
			`Selected profile: ${metadataLiteral(snapshot.selectedProfile.name)} (selected by ${snapshot.selectedProfile.selectedBy})`,
		)
	}

	lines.push('', 'Winning sources (resolved values are deliberately omitted):')
	const entries = Object.entries(snapshot.sources).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	)
	if (entries.length === 0) {
		lines.push('  <none>')
	} else {
		for (const [key, source] of entries) {
			if (!source) continue
			lines.push(`  ${key}: ${formatEffectiveSource(source)}`)
		}
	}
	return lines.join('\n')
}

function formatEffectiveSource(source: EffectiveConfigSource): string {
	return source.kind === 'cli-flag'
		? `CLI flag ${source.flag}`
		: formatConfigSource(source, metadataLiteral)
}

/**
 * Dynamic source metadata becomes a quoted printable-ASCII literal.
 *
 * Escaping every non-ASCII code point is intentionally stronger than a C0
 * filter: C1 CSI/OSC/ST controls and bidi format characters can otherwise
 * change terminal state or make the visible precedence read backwards. A
 * backslash is escaped too, so a literal `\\u{202e}` in a path cannot be
 * mistaken for a code point this function encoded.
 */
function metadataLiteral(value: string): string {
	const redacted = redactSourceMetadata(value)
	let out = '"'
	for (const character of redacted) {
		const codePoint = character.codePointAt(0)
		if (codePoint === undefined) continue
		if (character === '\\') out += '\\\\'
		else if (character === '"') out += '\\"'
		else if (codePoint >= 0x20 && codePoint <= 0x7e) out += character
		else out += `\\u{${codePoint.toString(16).padStart(4, '0')}}`
	}
	return `${out}"`
}

/** Use the SDK logger's one credential-pattern vocabulary at this new sink boundary. */
function redactSourceMetadata(value: string): string {
	let out = value
	for (const [label, pattern] of LOG_SECRET_PATTERNS) {
		// The public table contains reusable global regexes. Reset on both sides
		// so rendering one source cannot change whether the next source matches.
		pattern.lastIndex = 0
		out = out.replace(pattern, `[REDACTED:${label}]`)
		pattern.lastIndex = 0
	}
	return out
}

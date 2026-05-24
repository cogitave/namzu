/**
 * Output formatter abstraction for the @namzu/cli binary.
 *
 * Commands write structured data through a Formatter rather than building
 * strings directly. The active formatter is selected by the global
 * `--format` flag (default `text`). `--quiet` suppresses non-essential
 * (info/notice) output but always lets errors through.
 *
 * The doctor command predates this abstraction and continues to format its
 * own output via its `--json` flag; future milestones will unify when the
 * doctor JSON shape is reviewed as part of a deliberate session.
 */

export type FormatName = 'text' | 'json' | 'yaml'

export interface FormatterOptions {
	readonly quiet: boolean
}

export interface Formatter {
	readonly name: FormatName
	/** Emit a structured success payload to stdout. */
	print(data: unknown): void
	/** Emit a non-essential message; suppressed in quiet mode. */
	info(message: string): void
	/** Emit a structured error payload to stderr; never suppressed. */
	error(payload: { message: string; details?: unknown }): void
}

export function isFormatName(value: string): value is FormatName {
	return value === 'text' || value === 'json' || value === 'yaml'
}

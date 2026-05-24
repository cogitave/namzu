import { constants, accessSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export class ClawtoolBinaryError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ClawtoolBinaryError'
	}
}

export interface FindBinaryOptions {
	/** Explicit absolute path; if set, skips PATH search and returns this. */
	readonly override?: string
	/** PATH-like string for tests; defaults to `process.env.PATH`. */
	readonly path?: string
	/** Binary name; default `clawtool`. Configurable for win32 `.exe` testing. */
	readonly name?: string
}

/**
 * Locate the `clawtool` executable.
 *
 * Resolution order:
 *   1. Explicit `override` (config: `clawtool.binary`).
 *   2. First `<dir>/clawtool` in `$PATH` that is executable by the
 *      current user.
 *
 * Throws `ClawtoolBinaryError` with an actionable message when neither
 * yields a hit. We deliberately do not auto-build from source — that would
 * mask install errors in production deployments (see plan §M1 decision 2).
 */
export function findBinary(opts: FindBinaryOptions = {}): string {
	const name = opts.name ?? 'clawtool'
	if (opts.override) {
		assertExecutable(opts.override, name)
		return opts.override
	}
	const pathStr = opts.path ?? process.env.PATH ?? ''
	const dirs = pathStr.split(delimiter).filter((d) => d.length > 0)
	for (const dir of dirs) {
		const candidate = join(dir, name)
		if (isExecutable(candidate)) return candidate
	}
	throw new ClawtoolBinaryError(
		'clawtool binary not found in PATH. Install via `go install github.com/cogitave/clawtool/cmd/clawtool@latest` or set `clawtool.binary` in your namzu config.',
	)
}

function assertExecutable(path: string, name: string): void {
	if (!isExecutable(path)) {
		throw new ClawtoolBinaryError(
			`configured \`clawtool.binary\` path is not executable: ${path} (looking for \`${name}\`)`,
		)
	}
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK)
		return true
	} catch {
		return false
	}
}

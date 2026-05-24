import { inspect } from 'node:util'

import type { Formatter, FormatterOptions } from './formatter.js'

export class TextFormatter implements Formatter {
	readonly name = 'text' as const

	constructor(private readonly opts: FormatterOptions) {}

	print(data: unknown): void {
		process.stdout.write(`${renderText(data)}\n`)
	}

	info(message: string): void {
		if (this.opts.quiet) return
		process.stderr.write(`${message}\n`)
	}

	error(payload: { message: string; details?: unknown }): void {
		process.stderr.write(`Error: ${payload.message}\n`)
		if (payload.details !== undefined) {
			process.stderr.write(`${renderText(payload.details)}\n`)
		}
	}
}

function renderText(data: unknown): string {
	if (data === null || data === undefined) return ''
	if (typeof data === 'string') return data
	if (typeof data === 'number' || typeof data === 'boolean' || typeof data === 'bigint') {
		return String(data)
	}
	// `depth: 6` is generous for CLI payloads while keeping pathological
	// (deeply nested or self-referencing) graphs from exhausting stack/heap.
	// `inspect` already marks already-seen objects as `[Circular]`.
	return inspect(data, { depth: 6, colors: false, compact: false })
}

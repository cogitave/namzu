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

	// A payload that brought its own rendering gets to use it.
	//
	// Without this a command has to choose: print the structured payload,
	// which the `json` and `yaml` formats need, or print the human string,
	// which text needs. Every command that wanted both ended up passing the
	// object and letting `inspect` dump it — so `namzu eval` in its default
	// format printed a nested object graph where a report was meant to be,
	// with the readable version sitting unused in a `text` field one level
	// down. Found by running the built binary, not by a test: the test
	// asserted on the payload, which was correct, and never on what a
	// person sees.
	if (typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string') {
		return (data as { text: string }).text
	}
	// `depth: 6` is generous for CLI payloads while keeping pathological
	// (deeply nested or self-referencing) graphs from exhausting stack/heap.
	// `inspect` already marks already-seen objects as `[Circular]`.
	return inspect(data, { depth: 6, colors: false, compact: false })
}

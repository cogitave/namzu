import type { Formatter, FormatterOptions } from './formatter.js'

export class JsonFormatter implements Formatter {
	readonly name = 'json' as const

	constructor(private readonly opts: FormatterOptions) {}

	print(data: unknown): void {
		process.stdout.write(`${safeStringify(data)}\n`)
	}

	info(message: string): void {
		if (this.opts.quiet) return
		process.stderr.write(`${JSON.stringify({ level: 'info', message })}\n`)
	}

	error(payload: { message: string; details?: unknown }): void {
		const out: Record<string, unknown> = {
			level: 'error',
			message: payload.message,
		}
		if (payload.details !== undefined) out.details = payload.details
		process.stderr.write(`${safeStringify(out)}\n`)
	}
}

/**
 * `JSON.stringify` throws on circular references. The CLI must never crash
 * a command in the middle of emitting structured output, so we substitute
 * a sentinel for cycles and fall back to a safe shape on serializer error.
 */
function safeStringify(data: unknown): string {
	const seen = new WeakSet<object>()
	try {
		return JSON.stringify(
			data,
			(_key, value) => {
				if (typeof value === 'object' && value !== null) {
					if (seen.has(value as object)) return '[Circular]'
					seen.add(value as object)
				}
				if (typeof value === 'bigint') return value.toString()
				return value
			},
			2,
		)
	} catch (err) {
		return JSON.stringify({
			error: 'unserializable',
			detail: err instanceof Error ? err.message : String(err),
		})
	}
}

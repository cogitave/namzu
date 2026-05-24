import { stringify as yamlStringify } from 'yaml'

import type { Formatter, FormatterOptions } from './formatter.js'

export class YamlFormatter implements Formatter {
	readonly name = 'yaml' as const

	constructor(private readonly opts: FormatterOptions) {}

	print(data: unknown): void {
		process.stdout.write(yamlStringify(data))
	}

	info(message: string): void {
		if (this.opts.quiet) return
		process.stderr.write(yamlStringify({ level: 'info', message }))
	}

	error(payload: { message: string; details?: unknown }): void {
		const out: Record<string, unknown> = { level: 'error', message: payload.message }
		if (payload.details !== undefined) out.details = payload.details
		process.stderr.write(yamlStringify(out))
	}
}

import {
	type FormatName,
	type Formatter,
	type FormatterOptions,
	isFormatName,
} from './formatter.js'
import { JsonFormatter } from './json.js'
import { TextFormatter } from './text.js'
import { YamlFormatter } from './yaml.js'

export { isFormatName }
export type { FormatName, Formatter, FormatterOptions }

export function createFormatter(name: FormatName, opts: FormatterOptions): Formatter {
	switch (name) {
		case 'text':
			return new TextFormatter(opts)
		case 'json':
			return new JsonFormatter(opts)
		case 'yaml':
			return new YamlFormatter(opts)
		default: {
			// Exhaustiveness: TS will fail to compile this assignment if a new
			// FormatName variant is added without updating the switch.
			const _exhaustive: never = name
			throw new Error(`Unknown format: ${String(_exhaustive)}`)
		}
	}
}

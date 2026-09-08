import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import {
	type MCPJsonSchema,
	type StructuredOutputConfig,
	mcpJsonSchemaToZod,
	renderToolSchema,
} from '@namzu/sdk'

/** Resolve once at launch; the schema remains fixed for the session. */
export function loadOutputSchema(path: string): StructuredOutputConfig {
	const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Output schema must be a JSON Schema object.')
	const schema = mcpJsonSchemaToZod(value as MCPJsonSchema)
	const { $schema: _dialect, ...expected } = value as Record<string, unknown>
	if (!isDeepStrictEqual(renderToolSchema(schema), expected))
		throw new Error(
			'Output schema cannot be represented losslessly. Use an explicit object schema with properties, required and additionalProperties; unsupported constraints are not discarded.',
		)
	return {
		mode: 'native',
		schema,
	}
}

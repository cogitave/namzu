import { cloneJsonValue } from './json-snapshot.js'

/** Maximum UTF-8 JSON body retained by opt-in structured result spills. */
export const STRUCTURED_RESULT_MAX_BYTES = 16 * 1024 * 1024

/** Decode retained result evidence without coercing non-JSON values or rerunning a schema. */
export function parseStructuredResultJson(text: unknown): unknown {
	if (typeof text !== 'string') throw new TypeError('Structured result evidence must be JSON text')
	return cloneJsonValue(JSON.parse(text), false)
}

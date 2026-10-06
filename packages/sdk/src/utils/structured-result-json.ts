import { cloneJsonValue } from './json-snapshot.js'

/** Decode retained result evidence without coercing non-JSON values or rerunning a schema. */
export function parseStructuredResultJson(text: unknown): unknown {
	if (typeof text !== 'string') throw new TypeError('Structured result evidence must be JSON text')
	return cloneJsonValue(JSON.parse(text), false)
}

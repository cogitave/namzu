/**
 * The optional, zero-token report a pure scheduled script prints on stdout.
 * It is data from a confirmed script, never instructions for a model. A
 * malformed report is a failed check, not an implicit quiet poll.
 */

import { sanitizeLine } from '../../integrations/notifications/desktop/sanitize.js'

export const MAX_SCRIPT_REPORT_BYTES = 24 * 1024
export const MAX_SCRIPT_REPORT_SUMMARY_CHARS = 600
export const MAX_SCRIPT_STATE_BYTES = 16 * 1024

/** An environment variable round-trips UTF-8, so lone UTF-16 surrogates cannot be opaque state. */
export function isWellFormedScriptState(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const unit = value.charCodeAt(i)
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(++i)
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false
	}
	return true
}

export type ScriptReport =
	| { readonly v: 1; readonly state: 'quiet'; readonly nextState?: string }
	| {
			readonly v: 1
			readonly state: 'changed'
			/** One safe display line, never raw terminal control text. */
			readonly summary: string
			readonly nextState?: string
	  }

export type ParsedScriptReport =
	| { readonly ok: true; readonly result: ScriptReport }
	| { readonly ok: false; readonly reason: string }

function invalid(reason: string): ParsedScriptReport {
	return { ok: false, reason }
}

/** Parse exactly one JSON object line; an optional terminal newline is accepted. */
export function parseScriptReport(raw: string): ParsedScriptReport {
	if (Buffer.byteLength(raw, 'utf8') > MAX_SCRIPT_REPORT_BYTES)
		return invalid(`script report exceeds ${MAX_SCRIPT_REPORT_BYTES} UTF-8 bytes`)
	const line = raw.endsWith('\n') ? raw.slice(0, -1).replace(/\r$/, '') : raw
	if (line.length === 0 || /[\r\n]/.test(line))
		return invalid('script report must be exactly one JSON object line')
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch {
		return invalid('script report is not valid JSON')
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		return invalid('script report must be a JSON object')
	const input = parsed as Record<string, unknown>
	if (Object.keys(input).some((key) => !['v', 'state', 'summary', 'nextState'].includes(key)))
		return invalid('script report has an unsupported field')
	if (input.v !== 1) return invalid('script report v must be 1')
	if (input.state !== 'quiet' && input.state !== 'changed')
		return invalid('script report state must be quiet or changed')
	if (input.nextState !== undefined) {
		if (typeof input.nextState !== 'string')
			return invalid('script report nextState must be a string')
		if (input.nextState.includes('\0'))
			return invalid('script report nextState cannot contain NUL (U+0000)')
		if (!isWellFormedScriptState(input.nextState))
			return invalid('script report nextState must be well-formed Unicode')
		if (Buffer.byteLength(input.nextState, 'utf8') > MAX_SCRIPT_STATE_BYTES)
			return invalid(`script report nextState exceeds ${MAX_SCRIPT_STATE_BYTES} UTF-8 bytes`)
	}
	const nextState = input.nextState === undefined ? {} : { nextState: input.nextState as string }
	if (input.state === 'quiet') {
		if (Object.hasOwn(input, 'summary'))
			return invalid('a quiet script report must not contain summary')
		return { ok: true, result: { v: 1, state: 'quiet', ...nextState } }
	}
	if (typeof input.summary !== 'string' || input.summary.trim().length === 0)
		return invalid('a changed script report needs a nonempty summary')
	if ([...input.summary].length > MAX_SCRIPT_REPORT_SUMMARY_CHARS)
		return invalid(`script report summary exceeds ${MAX_SCRIPT_REPORT_SUMMARY_CHARS} characters`)
	const summary = sanitizeLine(input.summary, MAX_SCRIPT_REPORT_SUMMARY_CHARS)
	if (!summary) return invalid('script report summary contains no visible text')
	return { ok: true, result: { v: 1, state: 'changed', summary, ...nextState } }
}

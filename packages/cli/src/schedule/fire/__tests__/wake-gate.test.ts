/**
 * The wake-gate's output contract: exactly one JSON line, its own last (or
 * only) line, `{"wake": boolean, "context": string}`.
 */

import { describe, expect, it } from 'vitest'
import { parseWakeGateOutput } from '../wake-gate.js'

describe('the common cases', () => {
	it('wake: false, empty context', () => {
		const result = parseWakeGateOutput('{"wake":false,"context":""}\n', 4_000)
		expect(result).toEqual({ ok: true, result: { wake: false, context: '' } })
	})

	it('wake: true, with context', () => {
		const result = parseWakeGateOutput('{"wake":true,"context":"disk at 95%"}\n', 4_000)
		expect(result).toEqual({ ok: true, result: { wake: true, context: 'disk at 95%' } })
	})

	it('reads the last line when the script logs progress first, and tolerates trailing blank lines', () => {
		const result = parseWakeGateOutput(
			'checking disk...\nchecking memory...\n{"wake":false,"context":""}\n\n\n',
			4_000,
		)
		expect(result).toEqual({ ok: true, result: { wake: false, context: '' } })
	})

	it('is the only line', () => {
		const result = parseWakeGateOutput('{"wake":true,"context":"x"}', 4_000)
		expect(result.ok).toBe(true)
	})
})

describe('malformed output, each its own reason', () => {
	it('no output at all', () => {
		expect(parseWakeGateOutput('', 4_000)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('no output'),
		})
		expect(parseWakeGateOutput('\n\n  \n', 4_000)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('no output'),
		})
	})

	it('non-JSON stdout', () => {
		expect(parseWakeGateOutput('nothing to report\n', 4_000)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('does not end with JSON'),
		})
	})

	it('a JSON value that is not an object', () => {
		for (const line of ['true', '"wake"', '42', '[true,""]']) {
			expect(parseWakeGateOutput(`${line}\n`, 4_000)).toMatchObject({
				ok: false,
				reason: expect.stringContaining('not an object'),
			})
		}
	})

	it('missing or non-boolean wake', () => {
		expect(parseWakeGateOutput('{"context":"x"}\n', 4_000)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('"wake"'),
		})
		expect(parseWakeGateOutput('{"wake":"true","context":"x"}\n', 4_000)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('"wake"'),
		})
	})

	it('missing or non-string context', () => {
		expect(parseWakeGateOutput('{"wake":true}\n', 4_000)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('"context"'),
		})
		expect(parseWakeGateOutput('{"wake":true,"context":42}\n', 4_000)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('"context"'),
		})
	})

	it('more than one line of stdout parses as JSON', () => {
		const result = parseWakeGateOutput(
			'{"wake":false,"context":""}\n{"wake":true,"context":"x"}\n',
			4_000,
		)
		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringContaining('more than one line'),
		})
	})

	it('a non-JSON line after the contract line is not ambiguity — the LAST line is what counts', () => {
		// The script should not print after its contract line, but this checker
		// judges only the last line: text after it fails as "does not end with
		// JSON", not as a false positive on the JSON line before it.
		const result = parseWakeGateOutput('{"wake":true,"context":"x"}\nbye\n', 4_000)
		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringContaining('does not end with JSON'),
		})
	})
})

describe('the context cap', () => {
	it('truncates with an explicit marker, never silently', () => {
		const long = 'x'.repeat(5_000)
		const result = parseWakeGateOutput(`{"wake":true,"context":"${long}"}\n`, 4_000)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.result.context.length).toBeLessThan(5_000)
			expect(result.result.context.endsWith('...(truncated)')).toBe(true)
			expect(result.result.context.startsWith('x'.repeat(4_000))).toBe(true)
		}
	})

	it('leaves context under the cap untouched', () => {
		const result = parseWakeGateOutput('{"wake":true,"context":"short"}\n', 4_000)
		expect(result).toEqual({ ok: true, result: { wake: true, context: 'short' } })
	})
})

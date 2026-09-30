import { describe, expect, it } from 'vitest'
import {
	MAX_SCRIPT_REPORT_BYTES,
	MAX_SCRIPT_REPORT_SUMMARY_CHARS,
	MAX_SCRIPT_STATE_BYTES,
	parseScriptReport,
} from '../script-report.js'

describe('opt-in pure script report', () => {
	it('parses a quiet poll and a changed result, sanitizing only display text', () => {
		expect(parseScriptReport('{"v":1,"state":"quiet","nextState":"{\\"seen\\":2}"}\n')).toEqual({
			ok: true,
			result: { v: 1, state: 'quiet', nextState: '{"seen":2}' },
		})
		expect(
			parseScriptReport(
				JSON.stringify({
					v: 1,
					state: 'changed',
					summary: 'Issue\u001b[31m\nupdated \u202e',
					nextState: 'opaque\nstate',
				}),
			),
		).toEqual({
			ok: true,
			result: { v: 1, state: 'changed', summary: 'Issue[31m updated', nextState: 'opaque\nstate' },
		})
	})

	it.each([
		['', 'one JSON object line'],
		['{}', 'v must be 1'],
		['[]', 'JSON object'],
		['{"v":1,"state":"quiet"}\n\n', 'one JSON object line'],
		['{"v":1,"state":"quiet"}\n{"v":1,"state":"changed","summary":"x"}', 'one JSON object line'],
		['{"v":2,"state":"quiet"}', 'v must be 1'],
		['{"v":1,"state":"unknown"}', 'quiet or changed'],
		['{"v":1,"state":"quiet","summary":""}', 'must not contain summary'],
		['{"v":1,"state":"changed"}', 'needs a nonempty summary'],
		['{"v":1,"state":"changed","summary":"\\u001b"}', 'no visible text'],
		['{"v":1,"state":"changed","summary":"ok","extra":1}', 'unsupported field'],
		['{"v":1,"state":"quiet","nextState":1}', 'must be a string'],
	])('rejects %s', (raw, reason) => {
		expect(parseScriptReport(raw)).toEqual({ ok: false, reason: expect.stringContaining(reason) })
	})

	it('bounds summary code points and state UTF-8 bytes independently', () => {
		const summary = '🙂'.repeat(MAX_SCRIPT_REPORT_SUMMARY_CHARS)
		expect(parseScriptReport(JSON.stringify({ v: 1, state: 'changed', summary })).ok).toBe(true)
		expect(
			parseScriptReport(JSON.stringify({ v: 1, state: 'changed', summary: `${summary}🙂` })),
		).toEqual({ ok: false, reason: expect.stringContaining('summary exceeds') })
		const state = '🙂'.repeat(MAX_SCRIPT_STATE_BYTES / 4)
		expect(parseScriptReport(JSON.stringify({ v: 1, state: 'quiet', nextState: state })).ok).toBe(
			true,
		)
		expect(
			parseScriptReport(JSON.stringify({ v: 1, state: 'quiet', nextState: `${state}🙂` })),
		).toEqual({ ok: false, reason: expect.stringContaining('nextState exceeds') })
		expect(parseScriptReport(' '.repeat(MAX_SCRIPT_REPORT_BYTES + 1))).toEqual({
			ok: false,
			reason: expect.stringContaining('UTF-8 bytes'),
		})
	})

	it('rejects a NUL in opaque state because the next process receives it through the environment', () => {
		expect(parseScriptReport(JSON.stringify({ v: 1, state: 'quiet', nextState: 'a\0b' }))).toEqual({
			ok: false,
			reason: expect.stringContaining('NUL (U+0000)'),
		})
	})

	it('rejects a lone surrogate rather than changing opaque state in the next process', () => {
		expect(parseScriptReport('{"v":1,"state":"quiet","nextState":"\\ud800"}')).toEqual({
			ok: false,
			reason: expect.stringContaining('well-formed Unicode'),
		})
		expect(parseScriptReport(JSON.stringify({ v: 1, state: 'quiet', nextState: '🙂' })).ok).toBe(
			true,
		)
	})
})

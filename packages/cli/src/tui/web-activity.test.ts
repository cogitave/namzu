import { describe, expect, it } from 'vitest'

import {
	countListedResults,
	formatBytes,
	webActivityFromInput,
	webCallTitle,
	webLiveStatus,
	webSettledLine,
} from './web-activity.js'

describe('web activity rows', () => {
	it('name the query searched for and the address fetched', () => {
		expect(webCallTitle({ kind: 'search', target: 'OpenClaw agent runtime' })).toBe(
			'Web search("OpenClaw agent runtime")',
		)
		expect(webCallTitle({ kind: 'search' })).toBe('Web search')
		expect(webCallTitle({ kind: 'fetch', target: 'https://docs.openclaw.ai/a' })).toBe(
			'Web fetch(https://docs.openclaw.ai/a)',
		)
		// A query is one line on the row, however the model wrote it.
		expect(webCallTitle({ kind: 'search', target: 'a\n  b' })).toBe('Web search("a b")')
	})

	it('say how a call is going while it runs', () => {
		expect(webLiveStatus({ kind: 'search', target: 'q' })).toBe('Searching: q')
		expect(webLiveStatus({ kind: 'search' })).toBe('Searching…')
		expect(webLiveStatus({ kind: 'fetch', target: 'https://docs.openclaw.ai/a/b' })).toBe(
			'Fetching docs.openclaw.ai…',
		)
		expect(webLiveStatus({ kind: 'fetch', target: 'not a url' })).toBe('Fetching not a url…')
	})

	it('settle to a count and a time', () => {
		expect(webSettledLine({ kind: 'search' }, { durationMs: 9_000 })).toBe('Did 1 search in 9.0s')
		expect(webSettledLine({ kind: 'search', results: 5 }, { durationMs: 12_400 })).toBe(
			'Found 5 results in 12s',
		)
		expect(webSettledLine({ kind: 'search', results: 1 }, {})).toBe('Found 1 result')
		expect(webSettledLine({ kind: 'fetch' }, { durationMs: 1_200, bytes: 7_680 })).toBe(
			'Received 7.5KB in 1.2s',
		)
		expect(webSettledLine({ kind: 'fetch' }, {})).toBe('Fetched')
	})

	it('read the target from a local call’s own input', () => {
		expect(webActivityFromInput('web_search', { query: 'x' })).toEqual({
			kind: 'search',
			target: 'x',
		})
		expect(webActivityFromInput('web_fetch', { url: 'https://a.dev' })).toEqual({
			kind: 'fetch',
			target: 'https://a.dev',
		})
		expect(webActivityFromInput('web_search', {})).toEqual({ kind: 'search' })
		expect(webActivityFromInput('read', { path: 'x' })).toBeUndefined()
	})

	it('count the results a local search listed, and only those', () => {
		expect(countListedResults('1. One\n   https://a\n2. Two\n   https://b')).toBe(2)
		expect(countListedResults('Title: A\nURL: https://a\n\nTitle: B\nURL: https://b')).toBe(2)
		expect(countListedResults('No results for "x".')).toBeUndefined()
		expect(countListedResults(undefined)).toBeUndefined()
	})

	it('size a fetched body the way a person reads it', () => {
		expect(formatBytes(512)).toBe('512B')
		expect(formatBytes(1_536)).toBe('1.5KB')
		expect(formatBytes(3 * 1024 * 1024)).toBe('3.0MB')
	})
})

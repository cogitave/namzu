import { describe, expect, it } from 'vitest'
import { OUTPUT_FRAME_POLICY, OUTPUT_FRAME_SANDBOX, outputFrameDocument } from './output-frame.js'

describe('the frame a written page is shown in', () => {
	it('has no permission at all', () => {
		expect(OUTPUT_FRAME_SANDBOX).toBe('')
		expect(OUTPUT_FRAME_SANDBOX).not.toContain('allow-same-origin')
		expect(OUTPUT_FRAME_SANDBOX).not.toContain('allow-top-navigation')
	})
	it('lets the page fetch nothing', () => {
		expect(OUTPUT_FRAME_POLICY).toContain("default-src 'none'")
		expect(OUTPUT_FRAME_POLICY).not.toMatch(/https?:|connect-src|script-src/)
	})
	it('puts the policy first in the head of a full page', () => {
		const out = outputFrameDocument(
			'<!DOCTYPE html><html><head><title>x</title></head><body></body></html>',
		)
		expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'))
		expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
	})
	it('puts the policy before anything else the file holds', () => {
		expect(outputFrameDocument('<html><body>hi</body></html>')).toMatch(
			/^<meta[^>]+><html><body>hi/,
		)
		expect(outputFrameDocument('<!doctype html><body>hi</body>')).toMatch(
			/^<!doctype html><meta[^>]+><body>hi/,
		)
		expect(outputFrameDocument('<p>hi</p>')).toMatch(/^<meta[^>]+><p>hi<\/p>$/)
		expect(outputFrameDocument('<HEAD lang="x"><TITLE>t</TITLE></HEAD>')).toMatch(
			/^<meta[^>]+><HEAD/,
		)
	})
	it('is not fooled by a head tag inside a comment or by markup before the head', () => {
		const out = outputFrameDocument(
			'<!-- <head> --><img src="data:,x"><head><title>t</title></head>',
		)
		expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
		expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<!--'))
	})
})

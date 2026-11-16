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
	it('adds a head to a page that has none, and wraps a bare fragment', () => {
		expect(outputFrameDocument('<html><body>hi</body></html>')).toMatch(
			/^<html><head><meta[^>]+><\/head><body>hi/,
		)
		expect(outputFrameDocument('<!doctype html><body>hi</body>')).toMatch(
			/^<!doctype html><head><meta[^>]+><\/head><body>hi/,
		)
		expect(outputFrameDocument('<p>hi</p>')).toMatch(/^<head><meta[^>]+><\/head><p>hi<\/p>$/)
	})
	it('is not fooled by a head tag spelled in capitals or with attributes', () => {
		expect(outputFrameDocument('<HEAD lang="x"><TITLE>t</TITLE></HEAD>')).toMatch(
			/^<HEAD lang="x"><meta/,
		)
	})
})

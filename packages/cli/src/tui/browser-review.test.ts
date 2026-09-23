import { describe, expect, it } from 'vitest'

import { permissionQuestion, permissionTitle } from './PermissionOverlay.js'
import { buildPermissionReview, buildPermissionSummary } from './permission-review.js'

function call(name: string, input: Record<string, unknown>) {
	return { id: 'c1', name, input, isDestructive: false }
}

function summary(name: string, input: Record<string, unknown>) {
	const review = buildPermissionReview([call(name, input)])
	if (!review.ok) throw new Error('review refused')
	return buildPermissionSummary(review.text)
}

describe('a browser call on the review screen', () => {
	it('says what happens in words, not "run browser"', () => {
		const open = [call('browser', { action: 'navigate', url: 'https://github.com/login' })]
		expect(permissionTitle(open)).toBe('Open a web page')
		expect(permissionQuestion(open)).toBe('Do you want to open this page?')
		const back = [call('browser', { action: 'back' })]
		expect(permissionTitle(back)).toBe('Go back in the browser')
		expect(permissionQuestion(back)).toBe('Do you want to go back?')
		const click = [
			call('browser_act', { action: 'click', ref: 'e6', origin: 'https://shop.example' }),
		]
		expect(permissionTitle(click)).toBe('Click on https://shop.example')
		expect(permissionQuestion(click)).toBe('Do you want to do this on https://shop.example?')
		const type = [
			call('browser_act', { action: 'type', ref: 'e2', text: 'x', origin: 'https://a.example' }),
		]
		expect(permissionTitle(type)).toBe('Type on https://a.example')
	})

	it('shows the address as a person writes it, and what is sent when it differs', () => {
		const text = summary('browser', {
			action: 'navigate',
			url: 'https://tr.wikipedia.org/wiki/%C4%B0stanbul',
		}).text
		expect(text).toContain('Open: https://tr.wikipedia.org/wiki/İstanbul')
		expect(text).toContain('sent as: https://tr.wikipedia.org/wiki/%C4%B0stanbul')
		const plain = summary('browser', { action: 'navigate', url: 'https://example.com/' }).text
		expect(plain).toContain('Open: https://example.com/')
		expect(plain).not.toContain('sent as')
	})

	it('keeps a punycode host as it is: the host is where a lookalike hides', () => {
		const text = summary('browser', { action: 'navigate', url: 'https://xn--exmple-cua.com/' }).text
		expect(text).toContain('Open: https://xn--exmple-cua.com/')
	})

	it('lists every key of any other browser call', () => {
		const text = summary('browser_act', {
			action: 'type',
			ref: 'e2',
			text: 'hello',
			origin: 'https://a.example',
		}).text
		expect(text).toContain('text: "hello"')
		expect(text).toContain('origin: "https://a.example"')
	})
})

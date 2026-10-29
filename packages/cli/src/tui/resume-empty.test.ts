import { describe, expect, it } from 'vitest'

import { noResumeText } from './resume-empty.js'

describe('what /resume says when it has nothing to offer', () => {
	it('says the only conversation is the open one when that is all the folder holds', () => {
		expect(noResumeText({ query: '', anyHere: true })).toBe(
			'The only conversation in this folder is the one already open.',
		)
	})

	it('says there is none yet when the folder holds nothing', () => {
		expect(noResumeText({ query: '', anyHere: false })).toBe(
			'No past conversations to resume in this folder yet.',
		)
	})

	it('names what was searched for when a search finds nothing', () => {
		expect(noResumeText({ query: 'billing', anyHere: true })).toContain('"billing"')
	})

	it('says no conversation is linked to a pull request, naming the number when one was asked for', () => {
		expect(noResumeText({ query: '', anyHere: true, pr: { kind: 'any' } })).toContain(
			'linked to a pull request',
		)
		expect(noResumeText({ query: '', anyHere: true, pr: { kind: 'number', number: 42 } })).toBe(
			'No conversation in this folder is linked to pull request #42.',
		)
	})
})

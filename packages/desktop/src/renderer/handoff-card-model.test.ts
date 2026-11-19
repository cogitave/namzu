import { expect, it } from 'vitest'
import type { DesktopTurnHandoff } from '../shared/protocol.js'
import { describeHandoff, siteName } from './handoff-card-model.js'

const base: DesktopTurnHandoff = {
	turnId: 't',
	checkpointId: 'c',
	reason: 'The site asks you to sign in',
	tool: 'browser',
	cause: 'sign-in',
	origin: 'https://github.com',
}

it('says a sign-in in plain words, naming the site and where to do it', () => {
	const card = describeHandoff({ ...base, window: 'visible' })
	expect(card.title).toBe('Namzu is waiting for you')
	expect(card.body).toBe(
		'Sign in to github.com in the browser window Namzu opened, then choose Continue.',
	)
	expect(card.fallback).toBeUndefined()
})

it('has a sentence for every reason the browser gives, and none says a tool or an id', () => {
	const said = (cause: string) => describeHandoff({ ...base, cause, window: 'visible' }).body
	expect(said('two-factor')).toContain('Finish signing in to github.com')
	expect(said('captcha')).toContain('Complete the check on github.com')
	expect(said('bot-block')).toContain('Get past the check on github.com')
	expect(said('http-auth')).toContain('Allow access to github.com')
	expect(said('credential-field')).toContain('Type the password or code on github.com')
	for (const cause of ['sign-in', 'two-factor', 'captcha', 'bot-block', 'http-auth'])
		expect(said(cause)).not.toMatch(/browser_human|human-required|turn|checkpoint/i)
})

it('says how to get a window when the browser has none, with the command to copy', () => {
	const card = describeHandoff({
		...base,
		window: 'none',
		loginCommand: 'namzu browser login default https://github.com',
	})
	expect(card.body).toContain('has no window of its own')
	expect(card.fallback?.command).toBe('namzu browser login default https://github.com')
})

it('hedges when it is not known whether a window is open, as after a conversation is opened again', () => {
	const card = describeHandoff({
		...base,
		loginCommand: 'namzu browser login default https://github.com',
	})
	expect(card.body).toContain('in the browser window Namzu opened')
	expect(card.fallback?.lead).toMatch(/No window on screen/)
})

it('uses the tool’s own words for any other tool, or a reason it has no sentence for', () => {
	expect(describeHandoff({ turnId: 't', checkpointId: 'c', reason: 'Plug in the key.' }).body).toBe(
		'Plug in the key. When that is done, choose Continue.',
	)
	expect(describeHandoff({ ...base, cause: 'something-new' }).body).toBe(
		'The site asks you to sign in. When that is done, choose Continue.',
	)
	expect(describeHandoff({ ...base, origin: undefined }).body).toContain('When that is done')
})

it('reads a site without its scheme or path', () => {
	expect(siteName('http://127.0.0.1:4173/login?x=1')).toBe('127.0.0.1:4173')
	expect(siteName('https://github.com')).toBe('github.com')
	expect(siteName(undefined)).toBeUndefined()
	expect(siteName('')).toBeUndefined()
})

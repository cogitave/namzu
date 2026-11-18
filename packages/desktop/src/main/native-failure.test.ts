import { expect, it } from 'vitest'
import { nativeFailureBody } from './native-failure.js'

it('puts a sentence first and the original under Details', () => {
	const body = nativeFailureBody(new Error('spawn /x/bin/node ENOENT'), 'start')
	expect(body.split('\n\n')[0]).toBe('That file or folder no longer exists. Choose another one.')
	expect(body).toContain('Details: spawn /x/bin/node ENOENT')
})
it('says what to do when the error has no sentence of its own', () => {
	const start = nativeFailureBody(new Error('kaboom: undefined is not a function'), 'start')
	expect(start).toMatch(/^Restart your computer, then open Namzu again\./)
	expect(start).toContain('Details: kaboom')
	const stop = nativeFailureBody(new Error('kaboom: undefined is not a function'), 'stop')
	expect(stop).toMatch(/^Namzu couldn’t close cleanly\./)
})
it('shows a sentence the app wrote as it is, without repeating it as Details', () => {
	expect(nativeFailureBody(new Error('Wait for the undo to finish.'), 'stop')).toBe(
		'Wait for the undo to finish.',
	)
})
it('maps an engine sentence from an older engine', () => {
	const body = nativeFailureBody(new Error('The ACP connection has closed.'), 'start')
	expect(body.split('\n\n')[0]).toBe(
		'Namzu lost its connection to this conversation. Try again, or restart Namzu if it keeps happening.',
	)
})

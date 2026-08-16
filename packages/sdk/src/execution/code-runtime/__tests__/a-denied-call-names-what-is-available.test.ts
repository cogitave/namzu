import { describe, expect, it } from 'vitest'

import { HostCallDeniedError } from '../types.js'

/**
 * The refusal a model actually reads.
 *
 * A program that called something it was not granted gets this message
 * back as a rejected promise, and the model gets it as the program's
 * failure. A bare "denied" sends it guessing at names; naming what IS
 * available is what lets it correct itself in the same turn rather than
 * spending another one asking.
 *
 * The runtime's own behaviour is pinned in the process-level suite beside
 * this file, which runs a real worker thread. This is the half that needs
 * no thread.
 */

describe('a denied call names what is available', () => {
	it('names the capability that was refused', () => {
		const err = new HostCallDeniedError({ name: 'secret', allowed: ['greet'] })

		expect(err.message).toContain('"secret"')
	})

	it('lists what the program COULD have called', () => {
		const err = new HostCallDeniedError({ name: 'secret', allowed: ['greet', 'lookup'] })

		expect(err.message).toContain('greet, lookup')
	})

	it('says `(none)` rather than trailing off, for a program granted nothing', () => {
		// An empty list rendered as an empty string reads as a truncated
		// message, and a model that thinks the message was cut asks again.
		const err = new HostCallDeniedError({ name: 'secret', allowed: [] })

		expect(err.message).toContain('(none)')
	})

	it('carries the detail a host would log, not only the prose', () => {
		const err = new HostCallDeniedError({ name: 'secret', allowed: ['greet'] })

		expect(err.details).toEqual({ name: 'secret', allowed: ['greet'] })
		expect(err.name).toBe('HostCallDeniedError')
	})
})

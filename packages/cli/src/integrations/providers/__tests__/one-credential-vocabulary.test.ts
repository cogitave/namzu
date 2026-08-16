import { isCredentialEnvKey } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { PROVIDER_REGISTRY } from '../registry.js'

/**
 * Three tables were about to disagree.
 *
 * This registry keeps `envVars` per provider — the names a credential is
 * read from. The SDK's host-bash scrub keeps key-name patterns — the names
 * a shell command must not inherit. The credential seam now reads the
 * second to answer the first.
 *
 * A name in one and not the other is not a cosmetic drift: it is a variable
 * this CLI reads an API key from and the scrub hands straight to a `bash`
 * call, whose output is appended to the durable transcript, persisted, and
 * re-sent to the model provider as history on every later turn.
 */

describe('one credential vocabulary, not three', () => {
	it('recognises every environment variable this registry reads a credential from', () => {
		const missed: string[] = []
		for (const entry of Object.values(PROVIDER_REGISTRY)) {
			for (const name of entry.envVars) {
				if (!isCredentialEnvKey(name)) missed.push(name)
			}
		}

		expect(missed).toEqual([])
	})

	it('has something to say — the registry is not empty', () => {
		// The assertion above passes trivially against an empty registry or a
		// registry whose entries declare no env vars, and both are states this
		// file has been in.
		const names = Object.values(PROVIDER_REGISTRY).flatMap((e) => [...e.envVars])

		expect(names.length).toBeGreaterThan(3)
	})

	it('would catch a provider variable the scrub cannot see', () => {
		// A rule nobody has watched fail is a rule nobody knows is running.
		// `_CREDS` matches none of the scrub's patterns and is not on its
		// exact list, so a provider added with one would leak.
		expect(isCredentialEnvKey('SOMEVENDOR_CREDS')).toBe(false)
		expect(isCredentialEnvKey('SOMEVENDOR_API_KEY')).toBe(true)
	})
})

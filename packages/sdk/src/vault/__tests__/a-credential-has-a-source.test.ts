import { describe, expect, it } from 'vitest'

import { EnvCredentialProvider, ReadOnlyCredentialProviderError } from '../CredentialProvider.js'

/**
 * Resolving a credential without the CLI.
 *
 * Every LLM-provider credential lookup lived in `@namzu/cli`, which walks a
 * provider registry and reads `process.env` itself. A host embedding the
 * SDK alone therefore had no way to plug in an env- or file-backed source
 * short of reimplementing `CredentialVault` — an interface that asks a
 * different question, holds a whole `AuthConfig` per connector, and has one
 * in-process implementation with no notion of writability at all.
 */

const provider = (env: NodeJS.ProcessEnv) => new EnvCredentialProvider({ env })

describe('a credential can be resolved through the SDK alone', () => {
	it('answers from an injected environment, naming its source', async () => {
		const p = provider({ ANTHROPIC_API_KEY: 'sk-test' })

		expect(await p.resolve('ANTHROPIC_API_KEY')).toEqual({ value: 'sk-test', source: 'env' })
	})

	it('treats an empty value as absent', async () => {
		// `FOO=` is what a shell script produces when its own lookup failed.
		// Reporting it as present sends a caller off to authenticate with
		// nothing, and the error they get points at the service rather than
		// at the variable.
		const p = provider({ ANTHROPIC_API_KEY: '' })

		expect(await p.resolve('ANTHROPIC_API_KEY')).toBeUndefined()
		expect((await p.describe('ANTHROPIC_API_KEY')).configured).toBe(false)
	})

	it('does not answer for a name that is not credential-shaped', async () => {
		// A provider that resolves ANY variable is a way to read arbitrary
		// process state through a seam whose name says "credential".
		const p = provider({ HOME: '/home/someone' })

		expect(await p.resolve('HOME')).toBeUndefined()
	})

	it('answers for any name when the caller asks for that explicitly', async () => {
		const p = new EnvCredentialProvider({ env: { HOME: '/home/someone' }, anyKey: true })

		expect(await p.resolve('HOME')).toEqual({ value: '/home/someone', source: 'env' })
	})
})

describe('describing a credential never returns it', () => {
	it('reports configured and the source, and no property holds the secret', async () => {
		// Asserted over every property rather than by naming the ones that
		// exist today: the failure this guards is a `value` field ADDED
		// later, which a check written against the current shape cannot see.
		const secret = 'sk-do-not-leak'
		const description = await provider({ ANTHROPIC_API_KEY: secret }).describe('ANTHROPIC_API_KEY')

		expect(description).toEqual({ configured: true, source: 'env', writable: false })
		expect(Object.values(description)).not.toContain(secret)
		expect(JSON.stringify(description)).not.toContain(secret)
	})

	it('names no source when nothing has it', async () => {
		// Absent rather than `source: 'env'` with `configured: false`, which
		// would read as "env has it and it is empty".
		expect(await provider({}).describe('ANTHROPIC_API_KEY')).toEqual({
			configured: false,
			writable: false,
		})
	})
})

describe('a read-only provider refuses a write', () => {
	it('throws, names an alternative, and changes nothing', async () => {
		// Both halves. A silent no-op passes "it did not throw" and leaves
		// the caller believing a credential was stored — which surfaces
		// later as an authentication error pointing nowhere.
		const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'original' }
		const p = provider(env)

		await expect(p.set('ANTHROPIC_API_KEY', 'replacement')).rejects.toThrow(
			ReadOnlyCredentialProviderError,
		)
		await expect(p.set('ANTHROPIC_API_KEY', 'replacement')).rejects.toThrow(
			/writable CredentialProvider/,
		)
		expect(env.ANTHROPIC_API_KEY).toBe('original')
	})

	it('refuses an unset the same way', async () => {
		const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'original' }

		await expect(provider(env).unset('ANTHROPIC_API_KEY')).rejects.toThrow(
			ReadOnlyCredentialProviderError,
		)
		expect(env.ANTHROPIC_API_KEY).toBe('original')
	})

	it('says it is not writable before anybody tries', async () => {
		// Discovering it by attempting a write means having attempted one
		// somewhere that permits it.
		expect((await provider({}).describe('ANTHROPIC_API_KEY')).writable).toBe(false)
	})
})

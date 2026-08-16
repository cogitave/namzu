import { describe, expect, it } from 'vitest'

import { isCredentialEnvKey, scrubInheritedEnv } from '../env-scrub.js'

/**
 * What an inherited environment is allowed to carry into a command the model
 * wrote.
 *
 * The host bash path spawned with `{ ...process.env, ...context.env }`, and
 * Namzu reads its own provider credentials out of the environment — so `env`,
 * `printenv`, or any build script that echoes its config returned the
 * operator's API keys as tool output. Tool output is appended to the durable
 * transcript, persisted, and re-sent to the provider as history on every later
 * turn, so one incidental `env` made a local secret permanent and remote.
 *
 * The sandboxed path never had the defect — it passed `context.env` alone —
 * which is why this was specifically the default configuration's problem.
 */

describe('a credential-shaped name is recognised', () => {
	it('catches the variables Namzu itself reads its providers from', () => {
		// These are not hypothetical: `cli/integrations/providers/registry.ts`
		// discovers credentials from exactly these names, so they are the ones
		// guaranteed to be present on an operator's machine.
		for (const key of [
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_TOKEN',
			'CLAUDE_CODE_OAUTH_TOKEN',
			'OPENAI_API_KEY',
			'OPENROUTER_API_KEY',
		]) {
			expect(isCredentialEnvKey(key), `${key} is not recognised as a credential`).toBe(true)
		}
	})

	it('catches the shapes a pattern alone would miss', () => {
		// Each of these is on the exact list because no name pattern matches it.
		// Deleting the exact-set lookup must fail this test.
		for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'KUBECONFIG', 'DOCKER_AUTH_CONFIG']) {
			expect(isCredentialEnvKey(key), `${key} is not recognised as a credential`).toBe(true)
		}
	})

	it('is case-insensitive, because an environment is not', () => {
		expect(isCredentialEnvKey('my_secret_thing')).toBe(true)
		expect(isCredentialEnvKey('Github_Token')).toBe(true)
	})

	it('leaves the variables a build actually needs alone', () => {
		// The host path is where an agent runs `pnpm test` and `make`. An
		// allowlist is correct in the sandbox and wrong here; if this test ever
		// goes red because the denylist became an allowlist, the trade was made
		// in the wrong direction.
		for (const key of ['PATH', 'HOME', 'NODE_ENV', 'CI', 'JAVA_HOME', 'TMPDIR', 'LANG']) {
			expect(isCredentialEnvKey(key), `${key} was withheld from a build`).toBe(false)
		}
	})
})

describe('scrubbing an inherited environment', () => {
	it('drops the credential and keeps everything else', () => {
		const { env, dropped } = scrubInheritedEnv({
			PATH: '/usr/bin',
			NODE_ENV: 'test',
			ANTHROPIC_API_KEY: 'sk-should-not-survive',
		})

		expect(env.PATH).toBe('/usr/bin')
		expect(env.NODE_ENV).toBe('test')
		expect(env.ANTHROPIC_API_KEY).toBeUndefined()
		expect(dropped).toEqual(['ANTHROPIC_API_KEY'])
	})

	it('reports the withheld name and never its value', () => {
		// The names go back to the model so a command that needed one fails
		// readably. Putting the value there would reintroduce the whole defect
		// through the diagnostic meant to explain it.
		const { dropped } = scrubInheritedEnv({ SOME_TOKEN: 'super-secret-value' })

		expect(dropped).toEqual(['SOME_TOKEN'])
		expect(JSON.stringify(dropped)).not.toContain('super-secret-value')
	})

	it('omits an unset variable rather than passing it as undefined', () => {
		const { env } = scrubInheritedEnv({ PATH: '/usr/bin', MISSING: undefined })

		expect('MISSING' in env).toBe(false)
	})

	it('returns names sorted so the diagnostic is stable', () => {
		const { dropped } = scrubInheritedEnv({ Z_TOKEN: 'a', A_SECRET: 'b', M_KEY: 'c' })

		expect(dropped).toEqual(['A_SECRET', 'M_KEY', 'Z_TOKEN'])
	})

	it('reads the live process environment when given none', () => {
		// The production call site passes no argument. A default that silently
		// scrubbed an empty object would pass every test above while protecting
		// nothing.
		process.env.NAMZU_ENV_SCRUB_PROBE_TOKEN = 'probe'
		try {
			const { env, dropped } = scrubInheritedEnv()

			expect(env.NAMZU_ENV_SCRUB_PROBE_TOKEN).toBeUndefined()
			expect(dropped).toContain('NAMZU_ENV_SCRUB_PROBE_TOKEN')
		} finally {
			// biome-ignore lint/performance/noDelete: `process.env` is not an ordinary object — assigning `undefined` stores the STRING "undefined" and the variable stays set, which is the opposite of what this cleanup is for.
			delete process.env.NAMZU_ENV_SCRUB_PROBE_TOKEN
		}
	})
})

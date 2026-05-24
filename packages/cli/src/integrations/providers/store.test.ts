import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { AnthropicProfile, OpenAIProfile } from './schema.js'
import {
	ProvidersStoreError,
	assertInvariants,
	findDefault,
	providersPath,
	readProfiles,
	resolveApiKey,
	writeProfiles,
} from './store.js'

function tmpHome(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-providers-'))
}

const anthropic = (over: Partial<AnthropicProfile> = {}): AnthropicProfile => ({
	name: 'a',
	type: 'anthropic',
	apiKey: 'sk-ant-deadbeef',
	...over,
})

const openai = (over: Partial<OpenAIProfile> = {}): OpenAIProfile => ({
	name: 'o',
	type: 'openai',
	apiKey: 'sk-openai-cafebabe',
	...over,
})

describe('readProfiles', () => {
	it('returns an empty array when the file is missing', () => {
		expect(readProfiles(tmpHome())).toEqual([])
	})

	it('throws ProvidersStoreError on malformed JSON', () => {
		const home = tmpHome()
		mkdirSync(join(home, '.namzu'))
		writeFileSync(join(home, '.namzu', 'providers.json'), '{not json}')
		expect(() => readProfiles(home)).toThrow(ProvidersStoreError)
	})

	it('throws on wrong version', () => {
		const home = tmpHome()
		mkdirSync(join(home, '.namzu'))
		writeFileSync(
			join(home, '.namzu', 'providers.json'),
			JSON.stringify({ version: 99, profiles: [] }),
		)
		expect(() => readProfiles(home)).toThrowError(/unsupported version/)
	})
})

describe('writeProfiles', () => {
	it('round-trips a profile through disk', () => {
		const home = tmpHome()
		writeProfiles([anthropic()], home)
		expect(readProfiles(home)).toEqual([anthropic()])
	})

	it('enforces mode 0600 on the file and 0700 on the directory', () => {
		const home = tmpHome()
		writeProfiles([anthropic()], home)
		const fileStat = statSync(providersPath(home))
		const dirStat = statSync(join(home, '.namzu'))
		expect(fileStat.mode & 0o777).toBe(0o600)
		expect(dirStat.mode & 0o777).toBe(0o700)
	})

	it('writes valid JSON that includes the version header', () => {
		const home = tmpHome()
		writeProfiles([anthropic()], home)
		const raw = readFileSync(providersPath(home), 'utf8')
		const parsed = JSON.parse(raw) as Record<string, unknown>
		expect(parsed.version).toBe(1)
		expect(Array.isArray(parsed.profiles)).toBe(true)
	})

	it('rejects duplicate names', () => {
		expect(() => writeProfiles([anthropic(), anthropic()], tmpHome())).toThrowError(
			/duplicate profile name/,
		)
	})

	it('rejects more than one default', () => {
		expect(() =>
			writeProfiles(
				[anthropic({ default: true }), openai({ name: 'o', default: true })],
				tmpHome(),
			),
		).toThrowError(/at most one/)
	})
})

describe('concurrent writes', () => {
	it('two simultaneous writeProfiles calls do not collide on the temp file', async () => {
		const home = tmpHome()
		// Fire two writes in parallel. Each carries a different profile set
		// so we can tell which one won the final rename — the important
		// guarantee is that NEITHER throws (no temp-path collision) and
		// the final on-disk state is exactly one of the two valid inputs
		// (no half-written, no merged garbage).
		const a = anthropic({ name: 'one' })
		const b = openai({ name: 'two' })
		await Promise.all([
			Promise.resolve().then(() => writeProfiles([a], home)),
			Promise.resolve().then(() => writeProfiles([b], home)),
		])
		const final = readProfiles(home)
		expect(final.length).toBe(1)
		expect(['one', 'two']).toContain(final[0]?.name)
	})
})

describe('assertInvariants', () => {
	it('passes for an empty store', () => {
		expect(() => assertInvariants([])).not.toThrow()
	})

	it('passes for a single profile with default=true', () => {
		expect(() => assertInvariants([anthropic({ default: true })])).not.toThrow()
	})
})

describe('resolveApiKey', () => {
	it('returns null when no key is anywhere', () => {
		const p: AnthropicProfile = { name: 'x', type: 'anthropic' }
		expect(resolveApiKey(p, {})).toBeNull()
	})

	it('reads from profile.apiKey when no env override', () => {
		expect(resolveApiKey(anthropic(), {})).toBe('sk-ant-deadbeef')
	})

	it('per-type env (ANTHROPIC_API_KEY) wins over file', () => {
		expect(resolveApiKey(anthropic(), { ANTHROPIC_API_KEY: 'env-key' })).toBe('env-key')
	})

	it('per-profile env (NAMZU_<NAME>_API_KEY) wins over per-type', () => {
		expect(
			resolveApiKey(anthropic({ name: 'work' }), {
				ANTHROPIC_API_KEY: 'type-key',
				NAMZU_WORK_API_KEY: 'profile-key',
			}),
		).toBe('profile-key')
	})

	it('normalizes profile names with non-alphanumerics in env lookup', () => {
		expect(
			resolveApiKey(anthropic({ name: 'work-1' }), { NAMZU_WORK_1_API_KEY: 'normalized' }),
		).toBe('normalized')
	})

	it('returns null for ollama (no api-key concept) when nothing is set', () => {
		expect(resolveApiKey({ name: 'local', type: 'ollama' }, {})).toBeNull()
	})
})

describe('findDefault', () => {
	it('returns the profile with default=true', () => {
		const list = [anthropic(), openai({ default: true })]
		expect(findDefault(list)?.name).toBe('o')
	})

	it('returns null when nothing is marked default', () => {
		expect(findDefault([anthropic(), openai()])).toBeNull()
	})
})

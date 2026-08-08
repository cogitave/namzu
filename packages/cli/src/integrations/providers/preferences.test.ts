import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	type Preferences,
	PreferencesError,
	preferencesPath,
	primaryProvider,
	readPreferences,
	writePreferences,
} from './preferences.js'

/**
 * POSIX file modes do not exist on Windows: `chmod` is a no-op there and
 * `fs.stat().mode` reports a fixed value, so these cases assert a
 * permission the platform cannot enforce. Skipping keeps the suite
 * meaningful on Windows instead of permanently red — the behavior itself
 * is still covered on Linux and macOS, where it actually matters.
 */
const IS_WINDOWS = process.platform === 'win32'

function tmpHome(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-prefs-'))
}

function writeRaw(home: string, body: unknown): void {
	mkdirSync(join(home, '.namzu'), { recursive: true })
	writeFileSync(join(home, '.namzu', 'preferences.json'), JSON.stringify(body))
}

describe('readPreferences', () => {
	it('reports missing when the file is absent', () => {
		expect(readPreferences(tmpHome())).toEqual({ status: 'missing' })
	})

	it('refuses a v1 file rather than guessing at it', () => {
		const home = tmpHome()
		writeRaw(home, { version: 1, default: 'peer', active: ['peer'] })
		const r = readPreferences(home)
		expect(r.status).toBe('needs-repick')
		if (r.status === 'needs-repick') {
			expect(r.reason).toMatch(/older schema/)
		}
	})

	it('throws on unparseable JSON', () => {
		const home = tmpHome()
		mkdirSync(join(home, '.namzu'))
		writeFileSync(join(home, '.namzu', 'preferences.json'), '{ not json')
		expect(() => readPreferences(home)).toThrow(PreferencesError)
	})

	it('round-trips a chain, in the order it was written', () => {
		const home = tmpHome()
		writePreferences(
			{
				version: 3,
				providers: [
					{ id: 'anthropic', model: 'a-model' },
					{ id: 'openai', model: 'another-model' },
					{ id: 'ollama' },
				],
			},
			home,
		)
		const r = readPreferences(home)
		expect(r.status).toBe('ok')
		if (r.status !== 'ok') throw new Error('expected ok')
		expect(r.prefs.providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'ollama'])
		expect(r.prefs.providers[1]?.model).toBe('another-model')
		// Omitted stays omitted: a member must not acquire a pinned model it
		// never asked for, or it stops tracking the registry default.
		expect(r.prefs.providers[2]?.model).toBeUndefined()
	})

	it('preserves subagents.active when present', () => {
		const home = tmpHome()
		writePreferences(
			{
				version: 3,
				providers: [{ id: 'anthropic' }],
				subagents: { active: ['one', 'two'] },
			},
			home,
		)
		const r = readPreferences(home)
		if (r.status !== 'ok') throw new Error('expected ok status')
		expect(r.prefs.subagents?.active).toEqual(['one', 'two'])
	})
})

describe('readPreferences migrates v2', () => {
	it('reads a v2 file as a one-element chain, carrying the model', () => {
		const home = tmpHome()
		writeRaw(home, { version: 2, provider: 'anthropic', model: 'a-model' })
		const r = readPreferences(home)
		expect(r.status).toBe('ok')
		if (r.status !== 'ok') throw new Error('expected ok')
		expect(r.prefs.version).toBe(3)
		expect(r.prefs.providers).toEqual([{ id: 'anthropic', model: 'a-model' }])
	})

	it('does not invent a model for a v2 file that pinned none', () => {
		const home = tmpHome()
		writeRaw(home, { version: 2, provider: 'openai' })
		const r = readPreferences(home)
		if (r.status !== 'ok') throw new Error('expected ok')
		expect(r.prefs.providers).toEqual([{ id: 'openai' }])
	})

	it('carries subagents across the migration', () => {
		const home = tmpHome()
		writeRaw(home, { version: 2, provider: 'anthropic', subagents: { active: ['one'] } })
		const r = readPreferences(home)
		if (r.status !== 'ok') throw new Error('expected ok')
		expect(r.prefs.subagents?.active).toEqual(['one'])
	})

	it('does not rewrite the file — a read has no write side effect', () => {
		const home = tmpHome()
		writeRaw(home, { version: 2, provider: 'anthropic' })
		readPreferences(home)
		const onDisk = JSON.parse(readFileSync(preferencesPath(home), 'utf8')) as { version: number }
		expect(onDisk.version).toBe(2)
	})

	it('still validates a migrated v2 chain', () => {
		const home = tmpHome()
		writeRaw(home, { version: 2, provider: 'not-a-provider' })
		const r = readPreferences(home)
		expect(r.status).toBe('needs-repick')
		if (r.status !== 'needs-repick') throw new Error('expected needs-repick')
		expect(r.reason).toMatch(/not a provider namzu knows/)
	})
})

describe('a chain is validated in full, not just at the head', () => {
	it('refuses an unknown provider in the TAIL, naming its position', () => {
		const home = tmpHome()
		writeRaw(home, {
			version: 3,
			providers: [{ id: 'anthropic' }, { id: 'not-a-provider' }],
		})
		const r = readPreferences(home)
		expect(r.status).toBe('needs-repick')
		if (r.status !== 'needs-repick') throw new Error('expected needs-repick')
		expect(r.reason).toContain('fallback #1')
		expect(r.reason).toContain('not-a-provider')
	})

	it('refuses a member repeated with the same model', () => {
		const home = tmpHome()
		writeRaw(home, {
			version: 3,
			providers: [
				{ id: 'anthropic', model: 'a-model' },
				{ id: 'anthropic', model: 'a-model' },
			],
		})
		const r = readPreferences(home)
		expect(r.status).toBe('needs-repick')
		if (r.status !== 'needs-repick') throw new Error('expected needs-repick')
		expect(r.reason).toMatch(/cannot be its own fallback/)
	})

	it('refuses a member repeated with no model on either', () => {
		const home = tmpHome()
		writeRaw(home, { version: 3, providers: [{ id: 'openai' }, { id: 'openai' }] })
		expect(readPreferences(home).status).toBe('needs-repick')
	})

	it('ALLOWS one provider twice with different models', () => {
		// A large model falling back to a small one on the same provider is a
		// real chain. Refusing every repeated id would forbid it.
		const home = tmpHome()
		writeRaw(home, {
			version: 3,
			providers: [
				{ id: 'anthropic', model: 'big' },
				{ id: 'anthropic', model: 'small' },
			],
		})
		expect(readPreferences(home).status).toBe('ok')
	})

	it('refuses an empty chain', () => {
		const home = tmpHome()
		writeRaw(home, { version: 3, providers: [] })
		expect(readPreferences(home).status).toBe('needs-repick')
	})
})

describe('writePreferences', () => {
	it.skipIf(IS_WINDOWS)('enforces mode 0600 on file and 0700 on dir', () => {
		const home = tmpHome()
		writePreferences({ version: 3, providers: [{ id: 'openai' }] }, home)
		const fileMode = statSync(preferencesPath(home)).mode & 0o777
		const dirMode = statSync(join(home, '.namzu')).mode & 0o777
		expect(fileMode).toBe(0o600)
		expect(dirMode).toBe(0o700)
	})

	it('rejects an empty chain', () => {
		expect(() => writePreferences({ version: 3, providers: [] }, tmpHome())).toThrow(
			PreferencesError,
		)
	})

	it('rejects a chain naming a provider that does not exist', () => {
		expect(() =>
			writePreferences({ version: 3, providers: [{ id: 'nope' as never }] }, tmpHome()),
		).toThrow(PreferencesError)
	})

	it('rejects a repeated member', () => {
		expect(() =>
			writePreferences({ version: 3, providers: [{ id: 'openai' }, { id: 'openai' }] }, tmpHome()),
		).toThrow(PreferencesError)
	})

	it('refuses to write an unsupported version', () => {
		expect(() =>
			writePreferences({ version: 2, providers: [{ id: 'openai' }] } as never, tmpHome()),
		).toThrow(PreferencesError)
	})
})

describe('primaryProvider', () => {
	it('is the head of the chain', () => {
		const prefs: Preferences = {
			version: 3,
			providers: [{ id: 'openai', model: 'a-model' }, { id: 'anthropic' }],
		}
		expect(primaryProvider(prefs)).toEqual({ id: 'openai', model: 'a-model' })
	})

	it('throws rather than inventing a provider nobody chose', () => {
		expect(() => primaryProvider({ version: 3, providers: [] })).toThrow(PreferencesError)
	})
})

/**
 * A saved primary this build cannot construct is refused when the file is READ.
 *
 * Where the refusal happens is the whole fix, not a detail. `needs-repick`
 * routes the operator to the picker with the reason printed above it;
 * construction-time refusal returns an empty session, which sets the
 * `unhealthy` phase — a disabled composer where `/model` cannot be typed. The
 * old message told them to pick another provider on the one screen that will
 * not let them.
 */
describe('a provider with no bundled driver', () => {
	it('refuses a saved PRIMARY at read time, so the operator lands in the picker', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-prefs-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(
			join(home, '.namzu', 'preferences.json'),
			JSON.stringify({ version: 3, providers: [{ id: 'bedrock' }] }),
		)

		const read = readPreferences(home)

		// `needs-repick`, not a throw and not `ok`. A throw would take the
		// operator out of the program; `ok` is what produced the dead end.
		expect(read.status).toBe('needs-repick')
		expect(read.status === 'needs-repick' && read.reason).toMatch(/not available in this build/)
	})

	it('does NOT refuse the file over a FALLBACK naming one', () => {
		// The asymmetry with the unknown-id check above it. An unbuildable spare
		// is dropped from the chain at launch with a notice and the session runs;
		// refusing the file would take a working primary away over it.
		const home = mkdtempSync(join(tmpdir(), 'namzu-prefs-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(
			join(home, '.namzu', 'preferences.json'),
			JSON.stringify({ version: 3, providers: [{ id: 'anthropic' }, { id: 'bedrock' }] }),
		)

		expect(readPreferences(home).status).toBe('ok')
	})

	it('cannot be written as a primary at all, so the picker can never save one', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-prefs-'))
		expect(() => writePreferences({ version: 3, providers: [{ id: 'lmstudio' }] }, home)).toThrow(
			/not available in this build/,
		)
	})
})

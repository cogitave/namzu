import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { disclose, disclosureText } from './disclosure.js'
import { parseManifest } from './manifest.js'
import { scopeOf, widerReasons } from './scope.js'

const REF = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'__fixtures__',
		'vectors',
		'reference-manifest.json',
	),
	'utf8',
)
const make = (retention: unknown) => {
	const m = JSON.parse(REF)
	m.produces[0].retentionDays = retention
	return parseManifest(JSON.stringify(m))
}
const ok = (retention: unknown) => {
	const r = make(retention)
	if (!r.ok) throw new Error(JSON.stringify(r.issues))
	return r.manifest
}

describe('retention: a number of days, or keep until the organisation deletes it', () => {
	it('accepts days and the word keep, and nothing else', () => {
		expect(make(7).ok).toBe(true)
		expect(make('keep').ok).toBe(true)
		for (const bad of ['forever', 'Keep', 0, 366, null, true]) expect(make(bad).ok).toBe(false)
	})
	it('says it in plain words in the notice text and the disclosure', () => {
		const m = ok('keep')
		const d = disclose(m, 'en', '/data')
		expect(d.dataKinds[0]?.retentionDays).toBe('keep')
		expect(disclosureText(d)).toContain('Kept until your organisation deletes it.')
		expect(disclosureText(disclose(ok(7), 'en', '/data'))).toContain('Kept 7 days.')
	})
	it('asks the person again when days become keep, never when keep becomes days', () => {
		const days = scopeOf(ok(7))
		const keep = scopeOf(ok('keep'))
		expect(widerReasons(days, keep).join(' ')).toContain('longer retention')
		expect(widerReasons(keep, days)).toEqual([])
		expect(widerReasons(keep, keep)).toEqual([])
		expect(widerReasons(days, scopeOf(ok(30))).join(' ')).toContain('longer retention')
	})
})

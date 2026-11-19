import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { disclose } from './disclosure.js'
import { parseManifest } from './manifest.js'

const REF = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'__fixtures__',
		'vectors',
		'reference-manifest.json',
	),
	'utf8',
)
const make = (f: (d: Record<string, any>, lang: string, other: string) => void) => {
	const m = JSON.parse(REF)
	const lang = m.defaultLocale as string
	f(m.produces[0], lang, m.locales.find((l: string) => l !== lang) ?? 'xx')
	return parseManifest(JSON.stringify(m))
}

describe('a data kind can give a plain title and an example for What is collected', () => {
	it('accepts both, in the default language', () => {
		const r = make((d, lang) => {
			d.title = { [lang]: 'Applications' }
			d.example = { [lang]: 'Microsoft Excel · 1 h 20 min' }
		})
		expect(r.ok).toBe(true)
		if (!r.ok) return
		const k = disclose(r.manifest, JSON.parse(REF).defaultLocale, '/data').dataKinds[0]
		expect(k?.title).toBe('Applications')
		expect(k?.example).toBe('Microsoft Excel · 1 h 20 min')
	})
	it('does not need them, and refuses one with no default-language text or one that is too long', () => {
		expect(make(() => {}).ok).toBe(true)
		expect(
			make((d, _lang, other) => {
				d.title = { [other]: 'Uygulamalar' }
			}).ok,
		).toBe(false)
		expect(
			make((d, lang) => {
				d.title = { [lang]: 'x'.repeat(61) }
			}).ok,
		).toBe(false)
		expect(
			make((d, lang) => {
				d.example = { [lang]: 'y'.repeat(121) }
			}).ok,
		).toBe(false)
	})
})

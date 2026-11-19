import { describe, expect, it } from 'vitest'
import { sampleManifest } from './__fixtures__/package-builder.js'
import { crossRules, parseManifest, pickLocale, resolveLocale, satisfiesRange } from './manifest.js'
import type { Manifest } from './types.js'

type M = Record<string, any>
const parse = (mutate: (m: M) => void = () => {}) =>
	parseManifest(JSON.stringify(sampleManifest(mutate as never)))
const refused = (mutate: (m: M) => void) => {
	const r = parse(mutate)
	if (r.ok) throw new Error('expected the manifest to be refused')
	return r.issues
}

describe('manifest: the id is a reverse DNS name', () => {
	it.each(['com.cogitave.activity', 'io.example-corp.team-notes', 'org.a.b.c', 'com.acme.v2'])(
		'accepts %s',
		(id) => {
			expect(
				parse((m) => {
					m.id = id
				}).ok,
			).toBe(true)
		},
	)
	it.each([
		'activity',
		'com.cogitave',
		'Com.Cogitave.Activity',
		'com-cogitave-activity',
		'com.cogitave.-activity',
		'com.cogitave.activity-',
		'com..activity',
		'com.cogitave.act_ivity',
		'1com.cogitave.activity',
	])('refuses %s with a sentence that shows a correct id', (id) => {
		const i = refused((m) => {
			m.id = id
		}).find((x) => x.path === 'id')
		expect(i?.message).toMatch(/reverse DNS name of the publisher's domain/)
		expect(i?.message).toMatch(/for example com\.example\.activity/)
	})
})

describe('manifest: accepted', () => {
	it('accepts the sample manifest', () => {
		expect(parse().ok).toBe(true)
	})
	it('accepts a package in one language only (no translations)', () => {
		const r = parse((m) => {
			m.locales = ['en']
			const strip = (o: any): void => {
				if (!o || typeof o !== 'object') return
				if (Array.isArray(o)) {
					o.forEach(strip)
					return
				}
				if ('en' in o && 'tr' in o) o.tr = undefined
				for (const v of Object.values(o)) strip(v)
			}
			strip(m)
			m.legal.notices.tr = undefined
		})
		expect(r.ok).toBe(true)
	})
	it('accepts a default language that is not English, with a third partial translation', () => {
		const r = parse((m) => {
			m.defaultLocale = 'tr'
			m.locales = ['tr', 'en', 'de']
			const swap = (o: any): void => {
				if (!o || typeof o !== 'object') return
				if (Array.isArray(o)) {
					o.forEach(swap)
					return
				}
				if ('en' in o && !('tr' in o)) o.tr = o.en
				for (const v of Object.values(o)) swap(v)
			}
			swap(m)
			m.permissions[0].summary.de = 'Sieht das vordere Programm.'
		})
		expect(r.ok).toBe(true)
	})
	it('lets keys starting with x- through', () => {
		expect(
			parse((m) => {
				m['x-build'] = 'ci-1'
			}).ok,
		).toBe(true)
	})
	it('accepts a publisher-own permission shown as other', () => {
		expect(
			parse((m) => {
				m.permissions.push({
					id: 'x-acme.probe',
					level: 'low',
					optional: false,
					personalData: false,
					summary: { en: 'Own probe' },
					purposes: [{ id: 'probe', text: { en: 'To probe things' } }],
				})
				m.produces.push({
					id: 'stub.probe.minute',
					from: ['x-acme.probe'],
					description: { en: 'Probe counts' },
					grain: 'minute',
					fields: [{ name: 'minute', type: 'timestamp', description: { en: 'Minute' } }],
					retentionDays: 7,
					leavesMachine: false,
				})
			}).ok,
		).toBe(true)
	})
})

describe('manifest: refused, each naming rule and path', () => {
	it('refuses a permission with no purpose, naming the permission', () => {
		const issues = refused((m) => {
			m.permissions[0].purposes = []
		})
		expect(
			issues.some((i) => i.path === 'permissions[0].purposes' && /no purpose/.test(i.message)),
		).toBe(true)
	})
	it('refuses a permission with the purposes key missing', () => {
		expect(
			refused((m) => {
				delete m.permissions[0].purposes
			}).some((i) => i.path === 'permissions[0].purposes'),
		).toBe(true)
	})
	it.each([
		['os.windowTitle', 'reserved for a later phase'],
		['os.screenshot', 'never offered'],
		['model.call', 'reserved for a later phase'],
		['os.keyContent', 'never offered'],
	])('refuses the permission %s', (id, why) => {
		expect(
			refused((m) => {
				m.permissions[0].id = id
			}).some((i) => i.message.includes(why)),
		).toBe(true)
	})
	it('refuses reserved fields by name', () => {
		for (const key of ['modelAccess', 'policy', 'managed', 'analysis']) {
			expect(
				refused((m) => {
					m[key] = { x: 1 }
				}).some((i) => i.path === key && /reserved/.test(i.message)),
			).toBe(true)
		}
		expect(
			refused((m) => {
				m.contributes.toolServers = []
			}).some((i) => i.path === 'contributes.toolServers'),
		).toBe(true)
		expect(
			refused((m) => {
				m.updates.source = 'https://x.test'
			}).some((i) => i.path === 'updates.source'),
		).toBe(true)
	})
	it('refuses an unknown key', () => {
		expect(
			refused((m) => {
				m.surprise = 1
			}).some((i) => i.path === 'surprise'),
		).toBe(true)
	})
	it('refuses runAtLogin, network hosts, upload, and a hidden indicator', () => {
		expect(
			refused((m) => {
				m.entry.process.runAtLogin = true
			}).some((i) => i.path === 'entry.process.runAtLogin'),
		).toBe(true)
		expect(
			refused((m) => {
				m.network = { mode: 'hosts', hosts: ['a.test'] }
			}).length,
		).toBeGreaterThan(0)
		expect(
			refused((m) => {
				m.produces[0].leavesMachine = true
			}).some((i) => /never leaves/.test(i.message)),
		).toBe(true)
		expect(
			refused((m) => {
				m.contributes.indicator.alwaysVisibleWhenRunning = false
			}).some((i) => /hidden|true/.test(i.message)),
		).toBe(true)
	})
	it('refuses an optional permission without a prompt, and a prompt on a required one', () => {
		expect(
			refused((m) => {
				delete m.permissions[1].prompt
			}).some((i) => i.path === 'permissions[1].prompt'),
		).toBe(true)
		expect(
			refused((m) => {
				m.permissions[0].prompt = { en: 'x y z' }
			}).some((i) => i.path === 'permissions[0].prompt'),
		).toBe(true)
	})
	it('refuses a path that climbs out of the package, and a shell-looking absolute exe', () => {
		const key = Object.keys(sampleManifest().entry as M)[0]
		expect(key).toBe('process')
		expect(
			refused((m) => {
				const k = Object.keys(m.entry.process.command)[0] as string
				m.entry.process.command[k].exe = '../x'
			}).some((i) => /exe$/.test(i.path)),
		).toBe(true)
		expect(
			refused((m) => {
				const k = Object.keys(m.entry.process.command)[0] as string
				m.entry.process.command[k].exe = '/bin/sh'
			}).some((i) => /exe$/.test(i.path)),
		).toBe(true)
	})
	it('refuses a bad locale tag and a text with no language', () => {
		expect(
			refused((m) => {
				m.locales.push('Turkish')
			}).some((i) => /locale/.test(i.path)),
		).toBe(true)
		expect(
			refused((m) => {
				m.description = {}
			}).some((i) => i.path === 'description'),
		).toBe(true)
	})
	it('L1: defaultLocale must be listed', () => {
		expect(
			refused((m) => {
				m.defaultLocale = 'de'
			}).some((i) => i.rule === 'L1'),
		).toBe(true)
	})
	it('L2: a text without the default language, and a used locale that is not listed', () => {
		expect(
			refused((m) => {
				delete m.permissions[0].purposes[0].text.en
			}).some((i) => i.rule === 'L2'),
		).toBe(true)
		expect(
			refused((m) => {
				m.name.fr = 'Enregistreur'
			}).some((i) => i.rule === 'L2'),
		).toBe(true)
	})
	it('L3: no notice in the default language', () => {
		expect(
			refused((m) => {
				delete m.legal.notices.en
			}).some((i) => i.rule === 'L3'),
		).toBe(true)
	})
	it('P2/P3: data from an undeclared permission; a permission nothing uses', () => {
		expect(
			refused((m) => {
				m.produces[0].from = ['x-undeclared']
			}).some((i) => i.rule === 'P2'),
		).toBe(true)
		expect(
			refused((m) => {
				m.permissions.push({
					id: 'x-extra',
					level: 'low',
					optional: false,
					personalData: false,
					summary: { en: 'Extra' },
					purposes: [{ id: 'extra', text: { en: 'Extra purpose' } }],
				})
			}).some((i) => i.rule === 'P3'),
		).toBe(true)
	})
	it('P4: a content-like field name (which key, which window)', () => {
		for (const name of ['keyCode', 'title', 'url', 'x']) {
			expect(
				refused((m) => {
					m.produces[0].fields.push({ name, type: 'text', description: { en: 'bad' } })
				}).some((i) => i.rule === 'P4'),
			).toBe(true)
		}
	})
	it('Q1/Q2/E1/E2/S1', () => {
		expect(
			refused((m) => {
				m.contributes.endpoint.queries[1].returns.push('stub.nope.minute')
			}).some((i) => i.rule === 'Q1'),
		).toBe(true)
		expect(
			refused((m) => {
				m.contributes.pages[0].source.counts = 'query:nope'
			}).some((i) => i.rule === 'Q2'),
		).toBe(true)
		expect(
			refused((m) => {
				m.platforms.push('win32-arm64')
			}).some((i) => i.rule === 'E1'),
		).toBe(true)
		expect(
			refused((m) => {
				m.entry.process.env.API_KEY = 'sk-live-123'
			}).some((i) => i.rule === 'E2'),
		).toBe(true)
		expect(
			refused((m) => {
				m.contributes.settings[0].usedBy = 'analysis'
			}).length,
		).toBeGreaterThan(0)
	})
	it('V: size, depth, byte order mark and bad JSON', () => {
		expect(parseManifest('{').ok).toBe(false)
		expect(parseManifest('﻿{}').ok).toBe(false)
		expect(parseManifest(Buffer.alloc(300 * 1024, 32)).ok).toBe(false)
		expect(parseManifest(Buffer.from([0x7b, 0xff, 0x7d])).ok).toBe(false)
		let deep: unknown = 1
		for (let i = 0; i < 20; i++) deep = { a: deep }
		expect(parseManifest(JSON.stringify({ 'x-deep': deep })).ok).toBe(false)
	})
	it('a failure stops at the first group and installs nothing: issues carry rule, path and message', () => {
		for (const i of refused((m) => {
			m.version = '1.0.0-beta'
		})) {
			expect(i.rule).toBeTruthy()
			expect(typeof i.path).toBe('string')
			expect(i.message.length).toBeGreaterThan(3)
		}
	})
	it('crossRules can run on a manifest value directly', () => {
		const r = parse()
		if (!r.ok) throw new Error('sample refused')
		expect(crossRules(r.manifest as Manifest)).toEqual([])
	})
})

describe('locales', () => {
	const m = { defaultLocale: 'tr', locales: ['tr', 'en', 'pt-BR'] }
	it('picks the exact tag, then the language, then the default', () => {
		expect(resolveLocale(m, 'pt-BR')).toEqual({ locale: 'pt-BR', available: true })
		expect(resolveLocale(m, 'en-GB')).toEqual({ locale: 'en', available: true })
		expect(resolveLocale(m, 'fr')).toEqual({ locale: 'tr', available: false })
		expect(resolveLocale(m, undefined)).toEqual({ locale: 'tr', available: true })
	})
	it('picks a text per locale with the default as the fallback', () => {
		expect(pickLocale({ tr: 'merhaba', en: 'hello' }, 'en', 'tr').text).toBe('hello')
		expect(pickLocale({ tr: 'merhaba' }, 'en', 'tr').text).toBe('merhaba')
		expect(pickLocale({ tr: 'merhaba', en: 'hello' }, 'en-US', 'tr').text).toBe('hello')
	})
})

describe('engine ranges', () => {
	it.each([
		['53.5.0', '>=53.5.0 <54', true],
		['53.4.1', '>=53.5.0 <54', false],
		['54.0.0', '>=53.5.0 <54', false],
		['1.2.3', '^1.2.0', true],
		['2.0.0', '^1.2.0', false],
		['1.2.9', '~1.2.0', true],
		['1.3.0', '~1.2.0', false],
		['3.0.0', '^1.0.0 || ^3.0.0', true],
	])('%s in %s is %s', (v, r, want) => {
		expect(satisfiesRange(v, r)).toBe(want)
	})
})

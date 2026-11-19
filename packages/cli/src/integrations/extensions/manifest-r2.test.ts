import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseManifest } from './manifest.js'

/** Round 2 of the manifest: pages, licence kinds, declared hosts, background and their cross rules. */
const REF = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'__fixtures__',
		'vectors',
		'reference-manifest.json',
	),
	'utf8',
)

type Edit = (m: any) => void
const run = (f: Edit = () => {}) => {
	const m = JSON.parse(REF)
	f(m)
	return parseManifest(JSON.stringify(m))
}
const rules = (f: Edit): string[] => {
	const r = run(f)
	return r.ok ? [] : r.issues.map((i) => i.rule)
}
const refused = (f: Edit, rule: string) => expect(rules(f)).toContain(rule)

const serviceLicensing = (host = 'license.example.com') => ({
	kind: 'service',
	required: true,
	claims: ['customer', 'expires'],
	onInvalid: 'disableAndExplain',
	service: {
		protocol: 'namzu-license/1',
		baseUrl: `https://${host}/v1`,
		verifier: {
			type: 'ed25519-offline',
			keyId: 'example-license-1',
			keyFile: 'keys/license-pub.json',
		},
		refreshHours: 24,
		offlineGraceDays: 14,
		sends: ['licenseKey', 'machineHash', 'extensionId', 'extensionVersion'],
		releaseOnRemove: true,
	},
})
const licenseHost = (host = 'license.example.com', use = ['license']) => ({
	mode: 'declared',
	hosts: [{ host, purpose: { tr: 'Lisans denetimi', en: 'Licence check' }, for: use }],
})

describe('round 2: what is accepted', () => {
	it('the reference manifest: key licence, background with a tray mark, one page and a chip', () => {
		expect(run().ok).toBe(true)
	})
	it('licence kind none, with only the kind', () => {
		expect(
			run((m) => {
				m.licensing = { kind: 'none' }
			}).ok,
		).toBe(true)
	})
	it('licence kind service with its host declared for the licence check', () => {
		expect(
			run((m) => {
				m.licensing = serviceLicensing()
				m.network = licenseHost()
				m.privacy.leavesTheMachine = 'licence-check-only'
			}).ok,
		).toBe(true)
	})
	it('a manifest with no ui and no background at all', () => {
		expect(
			run((m) => {
				m.ui = undefined
				m.background = undefined
				m.permissions = m.permissions.filter((p: any) => p.id !== 'background.signin')
			}).ok,
		).toBe(true)
	})
	it('actions with the /2 protocol', () => {
		expect(
			run((m) => {
				m.contributes.endpoint.protocol = 'namzu-ext-query/2'
				m.contributes.endpoint.actions = [
					{
						id: 'pick-day',
						paramsSchema: 'schemas/status.json',
						schema: 'schemas/status.json',
						maxBytes: 1024,
						purpose: { tr: 'Gün seç', en: 'Pick a day' },
						changes: 'view',
					},
				]
				m.ui.pages[0].bridge.allow.push('action:pick-day')
			}).ok,
		).toBe(true)
	})
})

describe('round 2: what is refused, naming the rule', () => {
	it('the old runAtLogin key is gone', () => {
		const r = run((m) => {
			m.entry.process.runAtLogin = false
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.issues[0]?.path).toBe('entry.process.runAtLogin')
	})
	it('B1: background without its permission, and the permission without the block', () => {
		refused((m) => {
			m.permissions = m.permissions.filter((p: any) => p.id !== 'background.signin')
		}, 'B1')
		refused((m) => {
			m.background = undefined
		}, 'B1')
	})
	it('B2: personal data in the background with no tray indicator', () => {
		refused((m) => {
			m.background.indicator = { kind: 'none' }
		}, 'B2')
	})
	it('B2 does not apply to a background extension that sees no personal data', () => {
		expect(
			rules((m) => {
				m.background.indicator = { kind: 'none' }
				for (const p of m.permissions) if (p.id.startsWith('os.')) p.personalData = false
			}),
		).not.toContain('B2')
	})
	it("B3: personalData that differs from Namzu's table for its own ids", () => {
		refused((m) => {
			m.permissions[0].personalData = false
		}, 'B3')
		refused((m) => {
			const p = m.permissions.find((x: any) => x.id === 'background.signin')
			p.personalData = true
		}, 'B3')
	})
	it('personalData is required on every permission', () => {
		const r = run((m) => {
			m.permissions[0].personalData = undefined
		})
		expect(r.ok).toBe(false)
	})
	it('N1: the licence host must be declared for the licence check', () => {
		refused((m) => {
			m.licensing = serviceLicensing()
			m.network = licenseHost('other.example.com')
			m.privacy.leavesTheMachine = 'licence-check-only'
		}, 'N1')
		refused((m) => {
			m.licensing = serviceLicensing()
			m.network = licenseHost('license.example.com', ['process'])
			m.privacy.leavesTheMachine = 'declared'
		}, 'N1')
	})
	it('N2: leavesTheMachine matches the hosts', () => {
		refused((m) => {
			m.network = licenseHost()
			m.licensing = serviceLicensing()
		}, 'N2')
		refused((m) => {
			m.network = licenseHost('license.example.com', ['license', 'process'])
			m.licensing = serviceLicensing()
			m.privacy.leavesTheMachine = 'licence-check-only'
		}, 'N2')
		refused((m) => {
			m.privacy.leavesTheMachine = 'declared'
		}, 'N2')
	})
	it('N3: the service must send both the key and the machine code', () => {
		refused((m) => {
			m.licensing = serviceLicensing()
			m.licensing.service.sends = ['licenseKey']
			m.network = licenseHost()
			m.privacy.leavesTheMachine = 'licence-check-only'
		}, 'N3')
	})
	it('a host must be a DNS name: no IP address, no wildcard, no scheme', () => {
		for (const bad of ['192.168.0.1', '*.example.com', 'https://license.example.com', 'localhost'])
			expect(
				run((m) => {
					m.network = licenseHost(bad)
				}).ok,
			).toBe(false)
	})
	it('A1: actions need the /2 protocol', () => {
		refused((m) => {
			m.contributes.endpoint.actions = [
				{
					id: 'pick-day',
					paramsSchema: 'schemas/status.json',
					schema: 'schemas/status.json',
					maxBytes: 1024,
					purpose: { tr: 'Gün seç', en: 'Pick a day' },
					changes: 'view',
				},
			]
		}, 'A1')
	})
	it('U2: a page may allow only the methods the endpoint declares', () => {
		refused((m) => {
			m.ui.pages[0].bridge.allow = ['query:nothing']
		}, 'U2')
		refused((m) => {
			m.ui.pages[0].bridge.allow = ['action:nothing']
		}, 'U2')
	})
	it('U3: a page is an .html file under ui/', () => {
		refused((m) => {
			m.ui.pages[0].entry = 'bin/page.html'
		}, 'U3')
		refused((m) => {
			m.ui.pages[0].entry = 'ui/page.js'
		}, 'U3')
	})
	it('U4: usesNetwork needs a host declared for the page', () => {
		refused((m) => {
			m.ui.pages[0].usesNetwork = true
			m.ui.pages[0].bridge.allow = []
		}, 'U4')
	})
	it('U5: a monitoring extension must carry the page Namzu draws itself', () => {
		refused((m) => {
			m.contributes.pages = []
		}, 'U5')
	})
	it("U6: a page cannot take the name of one of Namzu's own screens", () => {
		for (const id of [
			'notice',
			'permissions',
			'license',
			'licence',
			'install',
			'remove',
			'disable',
			'consent',
			'indicator',
		])
			refused((m) => {
				m.ui.pages[0].id = id
				m.ui.chips[0].opens = id
			}, 'U6')
	})
	it('U7: a page with the network cannot also call the extension', () => {
		refused((m) => {
			m.network = {
				mode: 'declared',
				hosts: [
					{
						host: 'pages.example.com',
						purpose: { tr: 'Sayfa verisi', en: 'Page data' },
						for: ['ui'],
					},
				],
			}
			m.privacy.leavesTheMachine = 'declared'
			m.ui.pages[0].usesNetwork = true
		}, 'U7')
	})
	it('U8: a chip opens only a page of this extension', () => {
		refused((m) => {
			m.ui.chips[0].opens = 'nowhere'
		}, 'U8')
	})
	it('the accent is a six-digit colour and an icon is an svg or png', () => {
		expect(
			run((m) => {
				m.ui.accent = 'green'
			}).ok,
		).toBe(false)
		expect(
			run((m) => {
				m.ui.icon = 'ui/icon.exe'
			}).ok,
		).toBe(false)
	})
	it('at most 6 pages and 2 chips; a chip state id is not free text', () => {
		expect(
			run((m) => {
				m.ui.chips[0].states['Not Valid'] = m.ui.chips[0].states.recording
			}).ok,
		).toBe(false)
		expect(
			run((m) => {
				m.ui.chips.push({ ...m.ui.chips[0], id: 'b' }, { ...m.ui.chips[0], id: 'c' })
			}).ok,
		).toBe(false)
	})
	it('an unknown key under ui or background is refused, an x- key is free', () => {
		expect(
			run((m) => {
				m.ui.script = 'x'
			}).ok,
		).toBe(false)
		expect(
			run((m) => {
				m.background.start = 'x'
			}).ok,
		).toBe(false)
		expect(
			run((m) => {
				m.ui['x-note'] = 'ok'
			}).ok,
		).toBe(true)
	})
	it('L2: the page and chip titles are localized in the default language', () => {
		refused((m) => {
			delete m.ui.pages[0].title.tr
		}, 'L2')
	})
})

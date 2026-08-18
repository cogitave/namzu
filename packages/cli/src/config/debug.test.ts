import { describe, expect, it } from 'vitest'

import { createConfigDebugSnapshot, formatConfigSource, renderConfigDebug } from './debug.js'
import type { ConfigProvenance } from './load.js'

describe('the effective config debug snapshot', () => {
	it('overlays only the CLI keys that actually won and keeps a fully overridden profile visible', () => {
		const snapshot = createConfigDebugSnapshot(
			{
				format: { kind: 'profile', name: 'ci', path: '/work/namzu.config.json' },
				quiet: { kind: 'profile', name: 'ci', path: '/work/namzu.config.json' },
				permissions: { kind: 'managed', path: '/etc/namzu/config.json' },
			},
			{
				formatFromCli: true,
				quietFromCli: true,
				selectedProfile: { name: 'ci', selectedBy: '--profile' },
			},
		)

		expect(snapshot.sources).toEqual({
			format: { kind: 'cli-flag', flag: '--format' },
			quiet: { kind: 'cli-flag', flag: '--quiet' },
			permissions: { kind: 'managed', path: '/etc/namzu/config.json' },
		})
		expect(snapshot.selectedProfile).toEqual({ name: 'ci', selectedBy: '--profile' })
		expect(Object.isFrozen(snapshot)).toBe(true)
		expect(Object.isFrozen(snapshot.sources)).toBe(true)
		// There is structurally nowhere for a resolved config value to hide.
		expect(snapshot).not.toHaveProperty('config')
		expect(snapshot).not.toHaveProperty('values')
	})

	it('does not claim an invalid or absent CLI value overrode loader provenance', () => {
		const provenance: ConfigProvenance = {
			format: { kind: 'env', variable: 'NAMZU_FORMAT' },
			quiet: { kind: 'default' },
		}

		expect(createConfigDebugSnapshot(provenance).sources).toEqual(provenance)
	})
})

describe('/debug-config rendering', () => {
	it('sorts keys deterministically and names every winning source without a value', () => {
		const rendered = renderConfigDebug(
			createConfigDebugSnapshot(
				{
					tui: { kind: 'user-file', path: '/home/alice/.namzu/config.yaml' },
					quiet: { kind: 'env', variable: 'NAMZU_QUIET' },
					permissions: { kind: 'project-file', path: '/work/namzu.config.json' },
					format: { kind: 'default' },
				},
				{
					selectedProfile: { name: 'review', selectedBy: 'NAMZU_PROFILE' },
				},
			),
		)

		expect(rendered).toContain('Selected profile: "review" (selected by NAMZU_PROFILE)')
		expect(rendered).toContain('format: default')
		expect(rendered).toContain('permissions: project-file "/work/namzu.config.json"')
		expect(rendered).toContain('quiet: env "NAMZU_QUIET"')
		expect(rendered).toContain('tui: user-file "/home/alice/.namzu/config.yaml"')
		expect(rendered.indexOf('format:')).toBeLessThan(rendered.indexOf('permissions:'))
		expect(rendered.indexOf('permissions:')).toBeLessThan(rendered.indexOf('quiet:'))
		expect(rendered.indexOf('quiet:')).toBeLessThan(rendered.indexOf('tui:'))
		expect(rendered).toContain('resolved values are deliberately omitted')
	})

	it('turns every dynamic field into redacted printable ASCII without changing rows', () => {
		const c0 = Array.from({ length: 0x20 }, (_, code) => String.fromCodePoint(code)).join('')
		const c1 = Array.from({ length: 0x21 }, (_, offset) =>
			String.fromCodePoint(0x7f + offset),
		).join('')
		const bidi = [
			...Array.from({ length: 5 }, (_, offset) => String.fromCodePoint(0x202a + offset)),
			...Array.from({ length: 4 }, (_, offset) => String.fromCodePoint(0x2066 + offset)),
		].join('')
		const separators = `${String.fromCodePoint(0x2028)}${String.fromCodePoint(0x2029)}`
		const credential = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234'
		const dangerous = `${c0}${c1}${bidi}${separators}\\"T\u0131rk\u00e7e\ud83d\ude42${credential}`
		const source = { kind: 'project-file', path: `/work/${dangerous}` } as const
		const rendered = renderConfigDebug(
			createConfigDebugSnapshot(
				{
					permissions: source,
					tui: source,
				},
				{ selectedProfile: { name: dangerous, selectedBy: '--profile' } },
			),
		)
		const safeRows = renderConfigDebug(
			createConfigDebugSnapshot(
				{
					permissions: { kind: 'project-file', path: '/work/safe' },
					tui: { kind: 'project-file', path: '/work/safe' },
				},
				{ selectedProfile: { name: 'safe', selectedBy: '--profile' } },
			),
		).split('\n').length

		// Static record separators are the only non-printable bytes left.
		expect(rendered).toMatch(/^[\x20-\x7e\n]*$/)
		expect(rendered.split('\n')).toHaveLength(safeRows)
		expect(rendered).toContain('\\u{001b}')
		expect(rendered).toContain('\\u{0085}')
		expect(rendered).toContain('\\u{009b}')
		expect(rendered).toContain('\\u{202e}')
		expect(rendered).toContain('\\u{2066}')
		expect(rendered).toContain('\\u{1f642}')
		expect(rendered).toContain('[REDACTED:openai-key]')
		expect(rendered).not.toContain(credential)
		// Both sources must redact: a reused /g pattern with stale lastIndex can
		// protect the first row and leak the second.
		expect(rendered.match(/\[REDACTED:openai-key\]/g)).toHaveLength(3)
	})

	it('shares one raw source vocabulary with boot logging', () => {
		expect(
			formatConfigSource({
				kind: 'profile',
				name: 'ci',
				path: '/work/namzu.config.json',
			}),
		).toBe('profile ci (/work/namzu.config.json)')
	})
})

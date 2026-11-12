import { describe, expect, it } from 'vitest'
import type { EngineDeliveryView, EngineStatus } from '../shared/engine-delivery-protocol.js'
import {
	engineDetailsLines,
	engineSourceText,
	engineStatusText,
	plainVersion,
	shortDate,
} from './engine-delivery-model.js'
import { lastCheckedText } from './settings-model.js'

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)
const checked = (at: number) => lastCheckedText(at, NOW)
const text = (status: EngineStatus) => engineStatusText(status, checked, NOW, 'en-GB')

describe('the engine row words', () => {
	it('says each state in plain words', () => {
		expect(text({ kind: 'off' })).toBe('Off. This app runs the engine it was installed with.')
		expect(text({ kind: 'override' })).toBe(
			'A developer override is in use, so the engine is not updated.',
		)
		expect(text({ kind: 'unknown' })).toBe('Not checked yet.')
		expect(text({ kind: 'checking' })).toBe('Checking for a newer engine…')
		expect(text({ kind: 'current', checkedAt: NOW - 5 * 60_000 })).toBe(
			'The engine is up to date. Last checked: 5 minutes ago.',
		)
		expect(text({ kind: 'ready', version: '52.0.0' })).toBe(
			'A newer engine (52.0.0) is ready. It takes effect the next time a project opens.',
		)
		expect(
			text({ kind: 'went-back', version: '52.0.0', problem: 'did-not-start', to: '51.1.0' }),
		).toBe('Could not use engine 52.0.0 (it did not start) and went back to 51.1.0.')
		expect(text({ kind: 'went-back', version: '52.0.0', problem: 'ended-early' })).toBe(
			'Could not use engine 52.0.0 (it kept stopping).',
		)
		expect(
			text({ kind: 'went-back', version: '52.0.0', problem: 'failed-checks', to: '51.1.0' }),
		).toContain('did not pass this app’s checks')
		expect(text({ kind: 'needs-newer-app' })).toBe(
			'A newer engine is out, but it needs a newer version of this app.',
		)
		expect(text({ kind: 'cannot-check', since: Date.UTC(2026, 10, 3) })).toBe(
			'Could not check for a newer engine since 3 Nov.',
		)
	})

	it('never says kernel, managed, manifest or bundle', () => {
		const everything: EngineStatus[] = [
			{ kind: 'off' },
			{ kind: 'override' },
			{ kind: 'unknown' },
			{ kind: 'checking' },
			{ kind: 'current', checkedAt: NOW },
			{ kind: 'ready', version: '52.0.0' },
			{ kind: 'went-back', version: '52.0.0', problem: 'failed-checks', to: '51.1.0' },
			{ kind: 'needs-newer-app' },
			{ kind: 'cannot-check', since: NOW },
		]
		for (const status of everything)
			expect(text(status)).not.toMatch(/kernel|managed|manifest|bundle/iu)
		for (const source of ['bundled', 'managed', 'override'] as const)
			expect(engineSourceText({ source, since: NOW }, NOW, 'en-GB')).not.toMatch(
				/kernel|managed|manifest|bundle/iu,
			)
	})

	it('says where the running engine came from', () => {
		expect(engineSourceText({ source: 'bundled' }, NOW, 'en-GB')).toBe('This app’s own engine.')
		expect(engineSourceText({ source: 'override' }, NOW, 'en-GB')).toBe('Developer override.')
		expect(
			engineSourceText({ source: 'managed', since: Date.UTC(2026, 10, 12, 8) }, NOW, 'en-GB'),
		).toBe('Updated by itself on 12 Nov.')
		expect(engineSourceText({ source: 'managed' }, NOW, 'en-GB')).toBe('Updated by itself.')
	})

	it('writes dates in the person’s language and adds the year for another year', () => {
		expect(shortDate(Date.UTC(2026, 10, 12, 8), NOW, 'en-GB')).toBe('12 Nov')
		expect(shortDate(Date.UTC(2026, 10, 12, 8), NOW, 'tr')).toBe('12 Kas')
		expect(shortDate(Date.UTC(2025, 10, 12, 8), NOW, 'en-GB')).toBe('12 Nov 2025')
	})

	it('draws a version as plain text of a sane length', () => {
		expect(plainVersion('52.0.0')).toBe('52.0.0')
		expect(plainVersion(undefined)).toBeUndefined()
		expect(plainVersion('9'.repeat(200))).toHaveLength(41)
		expect(plainVersion('1.0.0\u0000<img src=x onerror=alert(1)>')).toBe(
			'1.0.0<img src=x onerror=alert(1)>',
		)
		expect(plainVersion('1.0.0\n2')).toBe('1.0.02')
	})
})

describe('the facts "Copy details" carries', () => {
	const view = (over: Partial<EngineDeliveryView>): EngineDeliveryView => ({
		available: true,
		enabled: true,
		runs: { source: 'bundled', commandLine: '51.1.0', engine: '62.13.0' },
		bundled: { commandLine: '51.1.0', engine: '62.13.0' },
		status: { kind: 'unknown' },
		canUseOwn: false,
		...over,
	})

	it('adds nothing where this build cannot fetch engines', () => {
		expect(engineDetailsLines(view({ available: false }), NOW, 'en-GB')).toEqual([])
	})

	it('says the source, the status and, when a fetched engine runs, the fallback', () => {
		expect(engineDetailsLines(view({}), NOW, 'en-GB')).toEqual([
			'Engine source: This app’s own engine.',
			'Engine updates: Not checked yet.',
		])
		expect(
			engineDetailsLines(
				view({
					runs: {
						source: 'managed',
						commandLine: '52.0.0',
						engine: '62.14.0',
						since: Date.UTC(2026, 10, 12, 8),
					},
					status: { kind: 'current', checkedAt: Date.UTC(2026, 10, 12, 9) },
				}),
				NOW,
				'en-GB',
			),
		).toEqual([
			'Engine source: Updated by itself on 12 Nov.',
			'Namzu command line (this app’s own, used if the newer one cannot start) 51.1.0',
			'Engine updates: The engine is up to date. Last checked: 12 Nov.',
		])
	})
})

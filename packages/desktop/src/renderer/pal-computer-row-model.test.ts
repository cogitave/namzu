import { describe, expect, it } from 'vitest'
import type {
	PalComputerBlock,
	PalComputerSetupPlanView,
	PalComputerSetupState,
} from '../shared/pal-computer-setup.js'
import {
	type PalComputerRowView,
	consentSentence,
	humanSize,
	humanTime,
	palComputerRowView,
	progressLabel,
	windowsHelp,
} from './pal-computer-row-model.js'

const MB = 1024 * 1024
const full: PalComputerSetupPlanView = {
	id: 'p',
	steps: ['download', 'install', 'load-image'],
	downloadBytes: 351 * MB,
	seconds: 200,
	elevationPrompts: 1,
	mayRestart: true,
}
const image: PalComputerSetupPlanView = {
	id: 'i',
	steps: ['load-image'],
	downloadBytes: 0,
	seconds: 20,
	elevationPrompts: 0,
	mayRestart: false,
}
const state = (extra: Partial<PalComputerSetupState>): PalComputerSetupState => ({
	available: true,
	phase: 'needs-setup',
	plan: full,
	...extra,
})
const row = (setup: PalComputerSetupState | undefined, consenting = false) =>
	palComputerRowView({ palName: 'Kiro', setup, consenting })

/** Everything a person could read in a row. */
function texts(view: PalComputerRowView | undefined): string[] {
	if (!view) return []
	return [
		view.status,
		view.action?.label,
		view.consent?.sentence,
		view.note,
		view.help?.paragraphs.join(' '),
	].filter((text): text is string => typeof text === 'string')
}
// Engine names, codes and developer words that must never reach the screen (Details folds excepted).
const JARGON =
	/wslc|\bwsl\b|hcs|\bvmp\b|\bsku\b|hresult|0x[0-9a-f]{4,}|\bcode\b|\berror \d|enable-windows|download-wsl|load-image|undefined|\[object/i

describe('humanised numbers', () => {
	it('rounds sizes and times for reading', () => {
		expect(humanSize(0)).toBe('less than 1 MB')
		expect(humanSize(120 * MB)).toBe('120 MB')
		expect(humanSize(351 * MB)).toBe('351 MB')
		expect(humanSize(1.26 * 1024 * MB)).toBe('1.3 GB')
		expect(humanTime(20)).toBe('about 1 minute')
		expect(humanTime(200)).toBe('about 3 minutes')
	})
})

describe('palComputerRowView', () => {
	it('leaves the row alone when setup does not apply or nothing is needed', () => {
		expect(row(undefined)).toBeUndefined()
		expect(row({ available: false, phase: 'unknown' })).toBeUndefined()
		expect(row(state({ phase: 'ready', plan: undefined }))).toBeUndefined()
		expect(row(state({ phase: 'checking', plan: undefined }))).toBeUndefined()
		expect(row(state({ phase: 'unknown', plan: undefined }))).toBeUndefined()
	})

	it('offers Start on an image-only plan: pressing it is the consent', () => {
		const view = row(state({ phase: 'image-only', plan: image }))
		expect(view).toMatchObject({
			status: 'Offline',
			action: { kind: 'start', label: 'Start Kiro' },
			busy: false,
		})
		expect(view?.consent).toBeUndefined()
	})

	it('reads Preparing while the image is added', () => {
		const view = row(state({ phase: 'image-only', plan: image, running: { step: 'checking' } }))
		expect(view).toMatchObject({ status: 'Preparing Kiro’s computer…', busy: true })
		expect(view?.action).toBeUndefined()
		expect(
			row(state({ phase: 'image-only', plan: image, running: { step: 'load-image' } }))?.status,
		).toBe('Preparing Kiro’s computer…')
	})

	it('says Needs setup, and offers Set up and start on hover', () => {
		expect(row(state({}))).toMatchObject({
			status: 'Needs setup',
			action: { kind: 'ask', label: 'Set up and start Kiro' },
			busy: false,
		})
	})

	it('shows one sentence with what, how much, how long and what Windows asks', () => {
		const view = row(state({}), true)
		expect(view?.consent?.sentence).toBe(
			'Namzu will add Linux support to Windows and prepare Kiro’s computer. It downloads 351 MB. This takes about 3 minutes. Windows will ask your permission once. Your PC may need to restart, and Namzu continues by itself afterwards.',
		)
		expect(view?.action).toBeUndefined()
	})

	it('words a plan with no download and no permission', () => {
		expect(consentSentence({ ...image, steps: ['turn-on-features', 'load-image'] }, 'Kiro')).toBe(
			'Namzu will turn on the Windows features it needs and prepare Kiro’s computer. This takes about 1 minute. Windows will not ask for permission.',
		)
	})

	it('replaces the status with one progress label at a time', () => {
		const labels = [
			[{ step: 'checking' as const }, 'Checking this PC…'],
			[{ step: 'checking' as const, continuing: true }, 'Continuing setup…'],
			[
				{ step: 'download' as const, done: 120 * MB, total: 351 * MB },
				'Downloading Linux support · 120 MB of 351 MB',
			],
			[{ step: 'download' as const }, 'Downloading Linux support…'],
			[{ step: 'turn-on-features' as const }, 'Turning on Windows features…'],
			[{ step: 'install' as const }, 'Installing Linux support…'],
			[{ step: 'restart' as const }, 'Waiting for a restart…'],
			[{ step: 'load-image' as const }, 'Preparing Kiro’s computer…'],
		] as const
		for (const [running, label] of labels) {
			expect(progressLabel(running, 'Kiro', full)).toBe(label)
			expect(row(state({ running }))).toMatchObject({ status: label, busy: true })
		}
	})

	it('asks for a restart, with the note and the quiet action', () => {
		for (const setup of [
			state({ phase: 'restart-pending', plan: { ...full, steps: ['restart', 'load-image'] } }),
			state({ phase: 'needs-setup', outcome: { kind: 'restart-required' } }),
		])
			expect(row(setup)).toMatchObject({
				status: 'Restart to finish setup',
				note: 'Namzu continues by itself after you sign in again.',
				action: { kind: 'restart', label: 'Restart now' },
			})
	})

	it('explains each block in a plain sentence, with no Start', () => {
		const blocks: PalComputerBlock[] = [
			'virtualization-off',
			'organisation-policy',
			'windows-version',
			'processor',
			'update-needed',
			'image-missing',
		]
		const notes = blocks.map((reason) => {
			const view = row(
				state({ phase: 'blocked', plan: undefined, blocked: { reason, details: 'Plain detail.' } }),
			)
			expect(view?.action).toBeUndefined()
			expect(view?.details).toBe('Plain detail.')
			return view?.note
		})
		expect(notes[0]).toContain('virtualization')
		expect(notes[1]).toContain('organisation')
		expect(notes[2]).toContain('version of Windows')
		expect(notes[4]).toBe('Namzu needs an update to work with this version of Windows.')
		expect(new Set(notes).size).toBe(blocks.length)
	})

	it('says what happened when permission was declined, an administrator is needed, or setup failed', () => {
		expect(row(state({ outcome: { kind: 'cancelled' } }))).toMatchObject({
			status: 'Needs your permission',
			note: 'Setup needs your permission.',
			action: { kind: 'ask', label: 'Try again' },
		})
		expect(row(state({ outcome: { kind: 'needs-administrator' } }))).toMatchObject({
			note: 'Setup needs an administrator. Ask one to approve, or try again.',
			action: { label: 'Try again' },
		})
		expect(
			row(
				state({
					outcome: {
						kind: 'failed',
						sentence: 'Windows could not install Linux support.',
						details: 'Windows ended the step.',
					},
				}),
			),
		).toMatchObject({
			status: 'Setup did not finish',
			note: 'Windows could not install Linux support.',
			details: 'Windows ended the step.',
			action: { label: 'Try again' },
		})
	})

	it('keeps Start after a failed image load, with the sentence and the fold', () => {
		const view = row(
			state({
				phase: 'image-only',
				plan: image,
				outcome: {
					kind: 'failed',
					sentence: 'The Pal computer could not be added.',
					details: 'Not enough room.',
				},
			}),
		)
		expect(view).toMatchObject({
			action: { kind: 'start', label: 'Start Kiro' },
			note: 'The Pal computer could not be added.',
			details: 'Not enough room.',
		})
	})

	it('offers no action for a paused Pal', () => {
		expect(
			palComputerRowView({ palName: 'Kiro', setup: state({}), consenting: false, paused: true })
				?.action,
		).toBeUndefined()
	})

	it('puts the firmware and policy text in the collapsed help', () => {
		expect(windowsHelp('Kiro', 'virtualization-off').paragraphs.join(' ')).toMatch(/VT-x/)
		expect(windowsHelp('Kiro', 'organisation-policy').paragraphs.join(' ')).toMatch(/IT team/)
		expect(windowsHelp('Kiro', undefined).paragraphs.join(' ')).toMatch(/permission once/)
		expect(windowsHelp('Kiro', undefined).paragraphs.join(' ')).toMatch(/restart/)
	})

	it('never shows codes, engine names or developer words', () => {
		const views: (PalComputerRowView | undefined)[] = [
			row(state({})),
			row(state({}), true),
			row(state({ phase: 'image-only', plan: image })),
			row(state({ outcome: { kind: 'cancelled' } })),
			row(state({ outcome: { kind: 'needs-administrator' } })),
			row(state({ outcome: { kind: 'restart-required' } })),
			row(state({ running: { step: 'download', done: 5 * MB, total: 10 * MB } })),
			...(
				[
					'virtualization-off',
					'organisation-policy',
					'windows-version',
					'processor',
					'update-needed',
					'image-missing',
				] as const
			).map((reason) => row(state({ phase: 'blocked', plan: undefined, blocked: { reason } }))),
		]
		for (const view of views) for (const text of texts(view)) expect(text).not.toMatch(JARGON)
	})
})

import { Dialog } from '@base-ui/react/dialog'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../shared/update-protocol.js'
import { UpdateDialogContent } from './update-dialog.js'
import {
	readUiBusy,
	sameUiBusy,
	typingQuietMs,
	updateAnnouncement,
	updateBadge,
	updateDialogModel,
	updateMenuEntry,
} from './update-model.js'

const ready: UpdateState = { status: 'ready', version: '0.2.0' }

describe('badge', () => {
	it('shows only for an installable update, with the reference wording', () => {
		for (const status of ['disabled', 'idle', 'checking', 'error'] as const)
			expect(updateBadge(status === 'error' ? { status, message: 'x' } : { status })).toEqual({
				visible: false,
			})
		expect(updateBadge({ status: 'downloading', percent: 40, bytesPerSecond: 1 })).toEqual({
			visible: false,
		})
		expect(updateBadge(ready)).toEqual({
			visible: true,
			label: 'Update ready. Restart Namzu to install version 0.2.0',
			tooltip: 'Update ready — restart to install',
		})
	})

	it('announces once on the first transition to ready and never while downloading', () => {
		const downloading: UpdateState = { status: 'downloading', percent: 10, bytesPerSecond: 5 }
		expect(updateAnnouncement({ status: 'idle' }, downloading)).toBe('')
		expect(updateAnnouncement(downloading, downloading)).toBe('')
		expect(updateAnnouncement(downloading, ready)).toBe(
			'Update downloaded. Restart Namzu to install version 0.2.0.',
		)
		expect(updateAnnouncement(ready, { ...ready, waiting: ['turn-running'] })).toBe('')
	})
})

describe('dialog model', () => {
	it('has no dialog when there is nothing to install', () => {
		for (const state of [
			{ status: 'disabled' },
			{ status: 'idle' },
			{ status: 'checking' },
			{ status: 'error', message: 'x' },
		] as UpdateState[])
			expect(updateDialogModel(state)).toBeUndefined()
	})

	it('offers Restart now and Later when idle', () => {
		expect(updateDialogModel(ready)).toMatchObject({
			title: 'Update ready',
			actions: ['restart', 'later'],
			dismissible: true,
		})
		expect(updateDialogModel(ready)?.progress).toBeUndefined()
	})

	it('shows the real download percentage while downloading', () => {
		expect(
			updateDialogModel({ status: 'downloading', percent: 37, bytesPerSecond: 9 })?.progress,
		).toEqual({ value: 37, text: '37%' })
	})

	it('waits for the current reply and names why, when busy', () => {
		const model = updateDialogModel({
			status: 'ready',
			version: '0.2.0',
			waiting: ['turn-running', 'typing-unsaved'],
		})
		expect(model?.title).toBe('Installing update')
		expect(model?.body).toBe('Namzu will update when the current reply finishes.')
		expect(model?.reasons).toEqual(['A reply is still running', 'You are typing'])
		expect(model?.actions).toEqual(['later'])
	})

	it('is indeterminate and not dismissible while installing, never a made-up percentage', () => {
		const preparing = updateDialogModel({
			status: 'installing',
			version: '0.2.0',
			phase: 'preparing',
		})
		expect(preparing).toMatchObject({
			title: 'Installing update',
			body: 'Namzu will restart when installation finishes.',
			progress: { value: null, text: 'Preparing…' },
			actions: [],
			dismissible: false,
		})
		expect(
			updateDialogModel({ status: 'installing', version: '0.2.0', phase: 'installing' })?.progress,
		).toEqual({ value: null, text: 'Installing…' })
	})

	it('says plainly that it is still running after a failed install', () => {
		const model = updateDialogModel({ status: 'ready', version: '0.2.0', error: 'It stopped.' })
		expect(model?.body).toBe('It stopped. Namzu is still running.')
		expect(model?.actions).toEqual(['retry', 'close'])
	})

	it('puts only quiet entries in the profile menu', () => {
		expect(updateMenuEntry({ status: 'idle' })).toEqual({
			label: 'Check for updates',
			action: 'check',
		})
		expect(updateMenuEntry({ status: 'error', message: 'x' })?.label).toBe(
			'Update check failed. Retry',
		)
		expect(updateMenuEntry({ status: 'disabled' })).toBeUndefined()
		expect(updateMenuEntry({ status: 'checking' })).toBeUndefined()
		expect(updateMenuEntry(ready)?.action).toBe('open')
	})
})

describe('rendered dialog', () => {
	const html = (state: UpdateState) => {
		const model = updateDialogModel(state)
		if (!model) throw new Error('no dialog')
		return renderToStaticMarkup(
			createElement(
				Dialog.Root,
				{ open: true },
				createElement(UpdateDialogContent, { model, onAction: () => {} }),
			),
		)
	}

	it('renders a labelled, announced progress bar and the reference copy while installing', () => {
		const markup = html({ status: 'installing', version: '0.2.0', phase: 'preparing' })
		expect(markup).toContain('Installing update')
		expect(markup).toContain('Namzu will restart when installation finishes.')
		expect(markup).toContain('<progress')
		expect(markup).toContain('aria-label="Update progress"')
		expect(markup).not.toContain('value=')
		expect(markup).toContain('aria-live="polite"')
		expect(markup).toContain('Preparing…')
		expect(markup).not.toContain('<button')
	})

	it('renders a determinate bar with the download percentage', () => {
		const markup = html({ status: 'downloading', percent: 64, bytesPerSecond: 1 })
		expect(markup).toContain('value="64"')
	})

	it('renders Restart now first and Later second when idle', () => {
		const markup = html(ready)
		expect(markup.indexOf('Restart now')).toBeGreaterThan(-1)
		expect(markup.indexOf('Restart now')).toBeLessThan(markup.indexOf('Later'))
	})
})

describe('window facts', () => {
	it('counts only a foreign dialog and typing inside the quiet window', () => {
		const base = { foreignDialogs: 0, computerViews: 0, lastInputAt: undefined, now: 10_000 }
		expect(readUiBusy(base)).toEqual({
			dialogOpen: false,
			typingRecent: false,
			computerSession: false,
		})
		expect(readUiBusy({ ...base, foreignDialogs: 1, computerViews: 2 })).toMatchObject({
			dialogOpen: true,
			computerSession: true,
		})
		expect(readUiBusy({ ...base, lastInputAt: 10_000 - typingQuietMs + 1 }).typingRecent).toBe(true)
		expect(readUiBusy({ ...base, lastInputAt: 10_000 - typingQuietMs }).typingRecent).toBe(false)
	})

	it('compares reports field by field', () => {
		const quiet = { dialogOpen: false, typingRecent: false, computerSession: false }
		expect(sameUiBusy(quiet, { ...quiet })).toBe(true)
		expect(sameUiBusy(quiet, { ...quiet, typingRecent: true })).toBe(false)
	})
})

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { StatusBar, fitStatusLine } from '../StatusBar.js'
import { theme } from '../theme.js'
import { updateAmbient, updaterEventAmbient } from '../update-notice.js'

const update = updateAmbient({
	name: 'namzu',
	current: '1.0.0',
	latest: '1.1.0',
	how: 'namzu upgrade',
})

describe('the right end of the footer', () => {
	const base = { columns: 100, provider: null, model: 'm', modeLabel: '' }

	it('prefers a hint, then a notice, then the goal, then the standing item, then the model', () => {
		const all = { ...base, hint: 'h', notice: 'n', goal: 'g', ambient: 'a' }
		expect(fitStatusLine(all).right).toMatchObject({ text: 'h', source: 'hint' })
		expect(fitStatusLine({ ...all, hint: '' }).right).toMatchObject({ text: 'n', source: 'notice' })
		expect(fitStatusLine({ ...all, hint: '', notice: null }).right).toMatchObject({
			source: 'goal',
		})
		expect(fitStatusLine({ ...all, hint: '', notice: null, goal: null }).right).toMatchObject({
			source: 'ambient',
		})
		expect(fitStatusLine({ ...base }).right).toMatchObject({ kind: 'model' })
	})

	it('words the update pointer with the command to run', () => {
		expect(update.text).toBe('Update available! Run: namzu upgrade')
		const { lastFrame, unmount } = render(
			<StatusBar provider="p" model="m" state="idle" ambient={update} />,
		)
		expect(lastFrame()).toContain('Update available! Run: namzu upgrade')
		unmount()
	})

	it('draws an installed update with a check, in the ok colour, and an install in progress dim', () => {
		const done = updaterEventAmbient({ type: 'installed', from: '1.0.0', to: '1.1.0' })
		expect(done.tone).toBe('ok')
		const shown = render(<StatusBar provider="p" model="m" state="idle" ambient={done} />)
		expect(shown.lastFrame()).toContain('✓ Updated to 1.1.0 · restart to use it')
		shown.unmount()
		const working = updaterEventAmbient({ type: 'installing', to: '1.1.0' })
		const progress = render(<StatusBar provider="p" model="m" state="idle" ambient={working} />)
		expect(progress.lastFrame()).toContain('Updating to 1.1.0…')
		progress.unmount()
		// Two tones that read apart: the ok colour is not the muted one.
		expect(theme.status.ok).not.toBe(theme.text.muted)
	})

	it('keeps one row at 40 columns with a notice, dropping left items first', () => {
		const layout = fitStatusLine({
			columns: 40,
			provider: null,
			model: 'm',
			modeLabel: '⏵⏵ accept edits on',
			cycleSuffix: ' (shift+tab to cycle)',
			effort: 'high',
			interrupt: 'esc to interrupt',
			notice: '12% until auto-compact',
		})
		expect(layout.right).toMatchObject({ text: '12% until auto-compact' })
		const left = [layout.mode, layout.cycleSuffix, layout.effort, layout.interrupt]
			.filter(Boolean)
			.join(' · ')
		expect(left.length + 1 + '12% until auto-compact'.length).toBeLessThanOrEqual(40)
		expect(layout.interrupt).toBeNull()
	})
})

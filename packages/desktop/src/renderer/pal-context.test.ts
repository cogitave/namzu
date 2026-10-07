import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { PalContextCard, type PalContextProps } from './pal-context.js'

const pal: PalContextProps['pal'] = {
	id: 'pal',
	name: 'Palu',
	purpose: '',
	revision: 1,
	workspace: 'owned',
	model: null,
	paused: false,
	createdAt: '2026-10-07',
	updatedAt: '2026-10-07',
}

const base: PalContextProps = {
	pal,
	status: 'idle',
	computer: {
		name: 'Palu’s computer',
		workspace: 'owned',
		status: 'error',
		notice: 'Start the computer to continue.',
	},
	activity: [],
	outputs: [],
	onCustomize: () => {},
	onStartComputer: () => {},
	onOpenComputer: () => {},
}

it('keeps computer state and controls while omitting empty activity and output sections', () => {
	const html = renderToStaticMarkup(createElement(PalContextCard, base))
	expect(html).toContain('Start the computer to continue.')
	expect(html).toContain('Open Palu’s computer')
	expect(html).toContain('Start computer')
	expect(html).not.toContain('Recent activity')
	expect(html).not.toContain('No activity yet')
	expect(html).not.toContain('Outputs')
	expect(html).not.toContain('No outputs yet')
})

it('retains populated recent work and output controls', () => {
	const html = renderToStaticMarkup(
		createElement(PalContextCard, {
			...base,
			activity: [
				{
					id: 'work',
					title: 'Read a file',
					detail: 'In progress',
					status: 'working',
					category: 'file',
				},
			],
			outputs: [{ id: 'output', label: 'Notes', content: 'Visible only when opened' }],
		}),
	)
	expect(html).toContain('Recent activity')
	expect(html).toContain('In progress')
	expect(html).toContain('Outputs')
	expect(html).toContain('Notes')
})

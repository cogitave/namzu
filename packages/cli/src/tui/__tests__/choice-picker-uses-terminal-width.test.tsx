import { Box } from 'ink'
import { afterEach, expect, it } from 'vitest'

import { ChoicePicker } from '../ChoicePicker.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

it('uses available width for a finite choice label before truncating it', async () => {
	const label = 'preserve cancellation ownership'
	mounted = await renderToScreen(
		<ChoicePicker
			title="Select a commit to review"
			options={[
				{
					label,
					description: 'aaaaaaaaaaaa',
				},
			]}
			selected={0}
		/>,
		{ cols: 100, rows: 12 },
	)

	const viewport = mounted.viewport().join('\n')
	expect(viewport).toContain(label)
	expect(viewport).toContain('aaaaaaaaaaaa')
})

it('keeps badges, search, selected detail and controls visible on a narrow terminal', async () => {
	const options = Array.from({ length: 20 }, (_, index) => ({
		label: index === 10 ? '界界e\u0301 selected long label' : `option ${index}`,
		description: index === 10 ? 'Selected description' : 'Other description',
		current: index === 10,
		default: index === 10,
		selectedDescription: index === 10 ? 'Applies to future turns' : undefined,
	}))
	mounted = await renderToScreen(
		<ChoicePicker title="Select effort" options={options} selected={10} query="" />,
		{ cols: 40, rows: 14 },
	)
	const rows = mounted.viewport()
	const viewport = rows.join('\n')
	expect(viewport).toContain('Select effort')
	expect(viewport).toContain('11/20')
	expect(viewport).toContain('Search: Type to filter')
	expect(viewport).toContain('[current] [default]')
	expect(viewport).toContain('Selected description')
	expect(viewport).toContain('Applies to future turns')
	expect(viewport).toContain('enter · esc')
	expect(viewport).not.toContain('option 0')
	expect(mounted.scrollback().filter((row) => row.trim().length > 0)).toEqual(
		rows.filter((row) => row.trim().length > 0),
	)
})

it('reports an empty filtered result without a phantom selected row', async () => {
	mounted = await renderToScreen(
		<ChoicePicker title="Select branch" options={[]} selected={-1} query="unknown" />,
		{ cols: 40, rows: 14 },
	)
	const viewport = mounted.viewport().join('\n')
	expect(viewport).toContain('0/0')
	expect(viewport).toContain('No matching options')
	expect(viewport).toContain('Search: unknown')
	expect(viewport).not.toContain('1/0')
})

it('honors the parent width inside a padded 40-column App region', async () => {
	mounted = await renderToScreen(
		<Box paddingX={1}>
			<ChoicePicker
				title={'Choose a setting '.repeat(4)}
				columns={38}
				notice={'A notice '.repeat(12)}
				query=""
				selected={0}
				options={[
					{
						label: 'A long setting label',
						description: 'A long setting explanation repeated repeated',
						current: true,
						default: true,
						selectedDescription: 'Applies to future turns',
					},
					{ label: 'Other setting', description: 'Another explanation' },
				]}
			/>
		</Box>,
		{ cols: 40, rows: 14 },
	)
	const rows = mounted.viewport().filter((row) => row.trim().length > 0)
	expect(rows).toHaveLength(9)
	expect(rows.join('\n')).toContain('[current] [default]')
	expect(rows.join('\n')).toContain('enter · esc')
	expect(
		rows.every(
			(row) => (row.startsWith(' ') && row.endsWith('│')) || row.endsWith('┐') || row.endsWith('┘'),
		),
	).toBe(true)
})

it('shows a disabled reason without sacrificing the current marker at wide width', async () => {
	mounted = await renderToScreen(
		<ChoicePicker
			title="Choose"
			selected={0}
			options={[
				{ label: 'Current choice', description: 'x'.repeat(200), current: true },
				{
					label: 'Unavailable choice',
					description: 'Original description',
					disabledReason: 'Sign in first',
				},
			]}
		/>,
		{ cols: 80, rows: 18 },
	)
	const viewport = mounted.viewport().join('\n')
	expect(viewport).toContain('[current]')
	expect(viewport).toContain('Sign in first')
	expect(viewport).not.toContain('Original description')
})

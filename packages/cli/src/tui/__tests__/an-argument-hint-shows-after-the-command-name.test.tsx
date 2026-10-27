import { expect, it } from 'vitest'

import type { UserCommand } from '../../user-commands/store.js'
import { Composer } from '../Composer.js'
import { argumentHintFor, runSlash } from '../slashCommands.js'
import { renderToScreen } from './support/screen.js'

const triage: UserCommand = {
	name: 'triage',
	description: 'Triage a bug',
	template: 'Look at $ARGUMENTS.',
	path: '/skills/triage/SKILL.md',
	source: 'skill',
	argumentHint: '[issue-number]',
}
const tidy: UserCommand = {
	name: 'tidy',
	description: 'Tidy up',
	template: 'Tidy the repo.',
	path: '/skills/tidy/SKILL.md',
	source: 'skill',
}

it('offers the hint only once the name is complete and nothing follows it', () => {
	expect(argumentHintFor('/triage ', [triage])).toBe('[issue-number]')
	expect(argumentHintFor('/triage', [triage])).toBeUndefined()
	expect(argumentHintFor('/triage 42', [triage])).toBeUndefined()
	expect(argumentHintFor('/tidy ', [tidy])).toBeUndefined()
	expect(argumentHintFor('/other ', [triage])).toBeUndefined()
})

it('draws the hint after the name in the composer and drops it when typing starts', async () => {
	const screen = await renderToScreen(
		<Composer history={[]} onSubmit={() => {}} userCommands={[triage]} />,
		{ cols: 100, rows: 24 },
	)
	try {
		screen.press('/triage ')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('[issue-number]')
		screen.press('4')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).not.toContain('[issue-number]')
	} finally {
		await screen.unmount()
	}
})

it('lists the hint beside the description in the dropdown', async () => {
	const screen = await renderToScreen(
		<Composer history={[]} onSubmit={() => {}} userCommands={[triage]} />,
		{ cols: 100, rows: 24 },
	)
	try {
		screen.press('/tri')
		await screen.waitForRender()
		const view = screen.viewport().join('\n')
		expect(view).toContain('/triage')
		expect(view).toContain('[issue-number] Triage a bug')
	} finally {
		await screen.unmount()
	}
})

it('runs a skill command with its arguments substituted', () => {
	const action = runSlash('/triage 42', { userCommands: [triage] } as never)
	expect(action).toMatchObject({ kind: 'prompt' })
	expect((action as { text: string }).text).toBe('Look at 42.')
})

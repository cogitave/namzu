import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { TrustPrompt, unreadableTrustListNotice } from '../TrustPrompt.js'
import { renderToScreen } from './support/screen.js'

const notice = unreadableTrustListNotice({
	file: join(homedir(), '.namzu', 'trust.json'),
	reason: 'not valid JSON',
})

it('names the list with the home folder written short and says a yes holds for this session', () => {
	expect(notice).toContain(
		`(${join('~', '.namzu', 'trust.json')}) could not be read (not valid JSON)`,
	)
	expect(notice).toContain('a yes holds for this session only')
	expect(notice).toContain(
		`s starts a new list with this folder and keeps the old one in ${join('~', '.namzu', 'backups')}.`,
	)
	expect(notice).not.toContain(homedir())
})

it.each([40, 80])('says it inside the box, wrapped to it, at %i columns', async (cols) => {
	const screen = await renderToScreen(<TrustPrompt cwd="/srv/app" notice={notice} newList />, {
		cols,
		rows: 40,
	})
	try {
		const frame = screen.viewport()
		const text = frame
			.join(' ')
			.replace(/[│╭╮╰╯─]/g, ' ')
			.replace(/\s+/g, ' ')
		expect(text).toContain('Your trusted folders list')
		expect(text).toContain('namzu doctor shows its recovery copies.')
		expect(text).toContain(
			cols >= 80 ? 's start a new list with this folder' : 's start a new list',
		)
		for (const line of frame) expect(line.length).toBeLessThanOrEqual(cols)
	} finally {
		await screen.unmount()
	}
})

it('offers no new list while the list reads', async () => {
	const screen = await renderToScreen(<TrustPrompt cwd="/srv/app" />, { cols: 80, rows: 30 })
	try {
		expect(screen.viewport().join(' ')).not.toContain('start a new list')
	} finally {
		await screen.unmount()
	}
})

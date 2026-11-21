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
	expect(notice).not.toContain(homedir())
})

it.each([40, 80])('says it inside the box, wrapped to it, at %i columns', async (cols) => {
	const screen = await renderToScreen(<TrustPrompt cwd="/srv/app" notice={notice} />, {
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
		for (const line of frame) expect(line.length).toBeLessThanOrEqual(cols)
	} finally {
		await screen.unmount()
	}
})

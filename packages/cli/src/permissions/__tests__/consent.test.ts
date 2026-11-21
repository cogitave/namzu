import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { askBypassConsent } from '../consent-prompt.js'
import {
	acknowledgeBypass,
	acknowledgementsPath,
	hasAcknowledgedBypass,
	hasSeenAutoModeDefaultNotice,
	markAutoModeDefaultNoticeSeen,
} from '../consent.js'

const homes: string[] = []
afterEach(() => {
	for (const home of homes.splice(0)) removeTempDir(home)
})
const freshHome = () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-consent-'))
	homes.push(home)
	return home
}

describe('the one-time bypass acknowledgement', () => {
	it('is absent until it is given, then stays given', () => {
		const home = freshHome()

		expect(hasAcknowledgedBypass(home)).toBe(false)
		acknowledgeBypass(home, () => new Date('2026-10-21T10:00:00Z'))
		expect(hasAcknowledgedBypass(home)).toBe(true)
		expect(JSON.parse(readFileSync(acknowledgementsPath(home), 'utf8'))).toEqual({
			version: 1,
			bypass: '2026-10-21T10:00:00.000Z',
		})
	})

	it('keeps the first date when it is given again', () => {
		const home = freshHome()
		acknowledgeBypass(home, () => new Date('2026-10-21T10:00:00Z'))
		acknowledgeBypass(home, () => new Date('2027-01-01T00:00:00Z'))

		expect(JSON.parse(readFileSync(acknowledgementsPath(home), 'utf8')).bypass).toBe(
			'2026-10-21T10:00:00.000Z',
		)
	})

	it('reads a damaged file as not acknowledged, so the question is asked again', () => {
		const home = freshHome()
		acknowledgeBypass(home)
		writeFileSync(acknowledgementsPath(home), '{ not json')

		expect(hasAcknowledgedBypass(home)).toBe(false)
	})
})

describe('the notice that auto mode is the default', () => {
	it('is unseen until it is shown, then stays seen', () => {
		const home = freshHome()

		expect(hasSeenAutoModeDefaultNotice(home)).toBe(false)
		markAutoModeDefaultNoticeSeen(home, () => new Date('2026-11-21T09:00:00Z'))
		expect(hasSeenAutoModeDefaultNotice(home)).toBe(true)
		markAutoModeDefaultNoticeSeen(home, () => new Date('2027-01-01T00:00:00Z'))
		expect(JSON.parse(readFileSync(acknowledgementsPath(home), 'utf8'))).toEqual({
			version: 1,
			autoModeDefault: '2026-11-21T09:00:00.000Z',
		})
	})

	it('shares the file with the bypass acknowledgement, and neither write drops the other', () => {
		const home = freshHome()
		acknowledgeBypass(home, () => new Date('2026-10-21T10:00:00Z'))
		markAutoModeDefaultNoticeSeen(home, () => new Date('2026-11-21T09:00:00Z'))
		expect(JSON.parse(readFileSync(acknowledgementsPath(home), 'utf8'))).toEqual({
			version: 1,
			bypass: '2026-10-21T10:00:00.000Z',
			autoModeDefault: '2026-11-21T09:00:00.000Z',
		})

		const other = freshHome()
		markAutoModeDefaultNoticeSeen(other)
		acknowledgeBypass(other)
		expect(hasSeenAutoModeDefaultNotice(other)).toBe(true)
		expect(hasAcknowledgedBypass(other)).toBe(true)
	})

	it('reads a damaged file as unseen, so the notice shows again rather than never', () => {
		const home = freshHome()
		markAutoModeDefaultNoticeSeen(home)
		writeFileSync(acknowledgementsPath(home), '[]')

		expect(hasSeenAutoModeDefaultNotice(home)).toBe(false)
	})
})

describe('the question before the screen opens', () => {
	async function ask(answer: string | null): Promise<{ accepted: boolean; shown: string }> {
		const input = new PassThrough()
		const output = new PassThrough()
		let shown = ''
		output.on('data', (chunk) => {
			shown += String(chunk)
		})
		const pending = askBypassConsent({ input, output })
		if (answer === null) input.end()
		else input.write(`${answer}\n`)
		return { accepted: await pending, shown }
	}

	it.each(['y', 'Y', 'yes', ' YES '])('accepts %j', async (answer) => {
		expect((await ask(answer)).accepted).toBe(true)
	})

	it.each(['', 'n', 'no', 'maybe', 'yep', 'sure'])('declines %j', async (answer) => {
		expect((await ask(answer)).accepted).toBe(false)
	})

	it('declines at the end of input, so a script that reaches it never says yes', async () => {
		expect((await ask(null)).accepted).toBe(false)
	})

	it('says what bypass does before it asks', async () => {
		const { shown } = await ask('n')

		expect(shown).toContain('Run without asking?')
		expect(shown).toContain('including outside this folder')
		expect(shown).toContain('Start in bypass mode? [y/N]')
	})

	it('wraps the explanation on words at the width of the terminal', async () => {
		const input = new PassThrough()
		const output = Object.assign(new PassThrough(), { columns: 50 })
		let shown = ''
		output.on('data', (chunk) => {
			shown += String(chunk)
		})
		const pending = askBypassConsent({ input, output })
		input.write('n\n')
		await pending
		const body = shown.split('\n').filter((line) => !line.startsWith('Start in') && line !== '')
		for (const line of body) expect(line.length).toBeLessThanOrEqual(49)
		// A word is never cut: the sentence reads the same once rejoined.
		expect(body.join(' ')).toContain('including outside this folder')
		expect(body.join(' ')).toContain('on a machine you trust.')
	})
})

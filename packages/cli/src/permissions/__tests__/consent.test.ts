import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { askBypassConsent } from '../consent-prompt.js'
import { acknowledgeBypass, acknowledgementsPath, hasAcknowledgedBypass } from '../consent.js'

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
})

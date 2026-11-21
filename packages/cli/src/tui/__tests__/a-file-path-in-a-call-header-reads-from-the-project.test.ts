import { expect, it } from 'vitest'

import { pathSummary } from '../agent.js'
import { shortenPathMiddle } from '../shorten-path.js'

const cwd = '/work/space/proj'

it('shows a file inside the project relative to it, also when the summary was cut', () => {
	const path = `${cwd}/tests/${'deep/'.repeat(30)}report-json.test.ts`
	const cut = `${path.slice(0, 119)}…`
	expect(pathSummary(cut, { path }, cwd).endsWith('report-json.test.ts')).toBe(true)
	expect(pathSummary(cut, { path }, cwd).startsWith('/work')).toBe(false)
	expect(pathSummary(`${cwd}/a/b.ts`, { path: `${cwd}/a/b.ts` }, cwd)).toBe('a/b.ts')
})

it('cuts the middle of a long path and keeps the file name', () => {
	const shown = shortenPathMiddle(
		'src/very/long/folder/chain/that/goes/on/and/on/target-file.test.ts',
		40,
	)
	expect(shown.length).toBeLessThanOrEqual(40)
	expect(shown.startsWith('src/')).toBe(true)
	expect(shown.endsWith('/target-file.test.ts')).toBe(true)
	expect(shown).toContain('…')
})

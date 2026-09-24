import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The labels an `ask_user_question` call is shown and answered under must not
 * depend on the machine the turn runs on (issue #535).
 *
 * Whether two options carry the same marker, or whether taking one off would
 * repeat another option's label, is a comparison "letter case aside". Made
 * with `toLocaleLowerCase()`, it followed the host's `LANG`/`LC_ALL`: on a
 * Turkish host "ÖNERİLEN" and "Önerilen" matched and both markers came off; on
 * any other host both stayed. A turn resumed on a worker with another locale
 * could then quote a label the person was never shown.
 *
 * A process's default locale is fixed when it starts, so this cannot be
 * asserted in-process: each locale needs its own `node`. It reads the built
 * module, as the proc suite does.
 */

const DIST = join(import.meta.dirname, '../../../../dist/tools/coordinator/question-options.js')

const QUESTIONS = [
	[
		{ label: 'Lint (ÖNERİLEN)', recommended: true },
		{ label: 'Tests (Önerilen)', recommended: true },
	],
	[
		{ label: 'Lint (TAVSIYE EDİLEN)', recommended: true },
		{ label: 'Tests (Tavsiye edilen)', recommended: true },
	],
	[
		{ label: 'İZMİR (Önerilen)', recommended: true },
		{ label: 'Ankara (Önerilen)', recommended: true },
		{ label: 'İzmir' },
	],
	[{ label: 'KIRMIZI (Önerilen)', recommended: true }, { label: 'kırmızı' }],
]

interface Run {
	readonly locale: string
	readonly labels: string[][]
}

/** The locale a fresh `node` resolves under `locale`, and the labels it gives. */
function inLocale(locale: string): Run {
	const output = execFileSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`const { questionOptions } = await import(${JSON.stringify(DIST)})
			const questions = ${JSON.stringify(QUESTIONS)}
			process.stdout.write(JSON.stringify({
				locale: Intl.DateTimeFormat().resolvedOptions().locale,
				labels: questions.map((q) => questionOptions(q).map((o) => o.label)),
			}))`,
		],
		{ encoding: 'utf-8', env: { ...process.env, LANG: locale, LC_ALL: locale } },
	)
	return JSON.parse(output) as Run
}

describe('question labels ignore the host locale', () => {
	it('gives the same labels under a Turkish locale and under C', () => {
		const turkish = inLocale('tr_TR.UTF-8')
		const plain = inLocale('C')

		// The environment took: otherwise both runs share one locale and agree
		// no matter how the comparison is made.
		expect(turkish.locale).toMatch(/^tr\b/)
		expect(plain.locale).not.toMatch(/^tr\b/)

		expect(turkish.labels).toEqual(plain.labels)
		expect(plain.labels).toEqual([
			['Lint', 'Tests'],
			['Lint', 'Tests'],
			['İZMİR (Önerilen)', 'Ankara', 'İzmir'],
			['KIRMIZI (Önerilen)', 'kırmızı'],
		])
	})
})

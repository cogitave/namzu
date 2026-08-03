import { describe, expect, it } from 'vitest'

import { compressShellOutputFull } from '../shell-compress.js'

/**
 * `raw` here is bash stdout, and bash stdout is not something the run
 * itself typed — a fetched page, a piped response, a file an agent was
 * told to `cat`, all land in it verbatim. The pass-line detector's opening
 * alternative used to hunt for a PASS/ok marker with an unbounded
 * whitespace/bullet run in front of it. On a long line that never produces
 * that marker, the engine restarts the hunt at every offset in the line,
 * and this codebase's tool budgets cap payload bytes, not line length —
 * one crafted line was enough to pin a core testing the regex, and would
 * have done the same to the process compressing real output.
 */
describe('compressShellOutputFull', () => {
	it('does not hang on a long marker-free line (js/polynomial-redos regression)', () => {
		// 20 lines is `DEFAULT_MIN_LINES` — below it the function returns the
		// input untouched and the vulnerable regex is never reached.
		const poison = ' '.repeat(4000)
		const raw = [poison, ...Array.from({ length: 19 }, (_, i) => `line ${i}`)].join('\n')

		const start = Date.now()
		compressShellOutputFull(raw)
		const elapsedMs = Date.now() - start

		// The vulnerable regex takes ~20s on a line this size; a fixed one
		// finishes in low single-digit milliseconds. 1s leaves headroom for a
		// loaded CI box while still failing hard on a regression.
		expect(elapsedMs).toBeLessThan(1000)
	})

	it('still recognizes and suppresses repeated PASS markers', () => {
		// Distinct names, not indices: normalizeLine folds digits to `N`, so
		// index-numbered lines would collapse into one another in the repeat
		// pass and the assertion below would be measuring the wrong thing.
		const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
		const passLines = names.map((name) => `  ✓ test ${name} PASS `)
		const raw = [...passLines, ...Array.from({ length: 15 }, (_, i) => `other line ${i}`)].join(
			'\n',
		)

		const { text } = compressShellOutputFull(raw, { maxPassLines: 3 })

		expect(text).toContain('passing tests omitted')
		// Only the configured cap of PASS lines survives verbatim.
		expect(text.match(/✓ test \w+ PASS/g)?.length).toBe(3)
	})
})

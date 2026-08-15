import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { LOG_SECRET_PATTERNS, OUTPUT_SECRET_PATTERNS } from '../secret-patterns.js'

/**
 * This module exists to stop two pattern tables drifting apart again, so
 * the drift itself is what these tests pin: a leaf with no way back into
 * the graph, and a union with no gaps a single deleted entry can hide.
 */

const here = dirname(fileURLToPath(import.meta.url))
const leafSource = readFileSync(join(here, '..', 'secret-patterns.ts'), 'utf-8')

describe('the leaf module stays a leaf', () => {
	it('has zero import statements', () => {
		// A single `import` here re-creates the cycle this module exists to
		// avoid: `runtime/query/*` already imports `utils/logger.js`, so this
		// table importing anything back out of that graph would make it a
		// same-package cycle again — the exact failure that put it here.
		expect(leafSource).not.toMatch(/^\s*import\b/m)
	})
})

describe('each consumer sources its patterns from here, not a local literal', () => {
	const guardrailSource = readFileSync(
		join(here, '..', '..', 'runtime', 'query', 'guardrail-presets.ts'),
		'utf-8',
	)
	const errorsSource = readFileSync(join(here, '..', '..', 'provider', 'errors.ts'), 'utf-8')

	it('guardrail-presets.ts imports OUTPUT_SECRET_PATTERNS and defines no secret label locally', () => {
		expect(guardrailSource).toMatch(/OUTPUT_SECRET_PATTERNS/)
		expect(guardrailSource).toMatch(/from '\.\.\/\.\.\/constants\/secret-patterns\.js'/)
		// 'aws-access-key' only exists today inside the table this file used to
		// own. If it reappears in guardrail-presets.ts's own source, a second
		// literal table has been written back in beside the import.
		expect(guardrailSource).not.toMatch(/'aws-access-key'/)
	})

	it('errors.ts imports LOG_SECRET_PATTERNS and defines no secret regex locally', () => {
		expect(errorsSource).toMatch(/LOG_SECRET_PATTERNS/)
		expect(errorsSource).toMatch(/from '\.\.\/constants\/secret-patterns\.js'/)
		// The generic key-prefix regex used to be written out by hand here;
		// its reappearance means a second literal array crept back in.
		expect(errorsSource).not.toMatch(/\(\?:sk\|pk\|rk\)/)
	})
})

/**
 * One fixture per label in the union, chosen so that each fixture is
 * matched by exactly one pattern. That property is what makes the
 * "delete one, break one" loop below meaningful instead of accidental —
 * see the comment on `LOG_SECRET_PATTERNS` in `../secret-patterns.ts` for
 * the two lookahead adjustments that make it hold.
 */
const UNION_SAMPLES: ReadonlyArray<readonly [label: string, sample: string]> = [
	['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
	['github-token', `ghp_${'A'.repeat(24)}`],
	['anthropic-key', `sk-ant-api03-${'A'.repeat(25)}`],
	['openai-key', `sk-proj-${'A'.repeat(25)}`],
	['slack-token', `xoxb-1234567890-${'a'.repeat(12)}`],
	['google-api-key', `AIza${'A'.repeat(35)}`],
	['private-key-block', '-----BEGIN RSA PRIVATE KEY-----'],
	['jwt', `eyJ${'A'.repeat(12)}.eyJ${'B'.repeat(12)}.${'C'.repeat(12)}`],
	['npm-token', `npm_${'A'.repeat(25)}`],
	['bearer-token', `Bearer ${'A'.repeat(20)}`],
	['generic-key', `pk_live_${'A'.repeat(20)}`],
	['json-secret-field', '{"password":"hunter2","model":"safe"}'],
]

function redactWith(patterns: readonly (readonly [string, RegExp])[], text: string): string {
	let out = text
	for (const [label, pattern] of patterns) {
		// These are module-level `/g` regexes reused across calls; `.replace`
		// resets `lastIndex` itself for a global pattern, but resetting here
		// too keeps this helper correct if it is ever pointed at `.test`.
		pattern.lastIndex = 0
		out = out.replace(pattern, `[REDACTED:${label}]`)
	}
	return out
}

describe('LOG_SECRET_PATTERNS is the union, and every label in it fires', () => {
	it('has exactly one entry per fixture above — the two tables did not just get concatenated with dupes', () => {
		expect(LOG_SECRET_PATTERNS.map(([label]) => label).sort()).toEqual(
			UNION_SAMPLES.map(([label]) => label)
				.slice()
				.sort(),
		)
	})

	it.each(UNION_SAMPLES)('redacts the %s sample', (label, sample) => {
		const out = redactWith(LOG_SECRET_PATTERNS, `prefix ${sample} suffix`)
		expect(out).not.toContain(sample)
		expect(out).toContain(`[REDACTED:${label}]`)
	})

	it.each(LOG_SECRET_PATTERNS.map(([label]) => label))(
		'deleting the %s pattern breaks only its own sample',
		(removedLabel) => {
			const reduced = LOG_SECRET_PATTERNS.filter(([label]) => label !== removedLabel)
			for (const [label, sample] of UNION_SAMPLES) {
				const out = redactWith(reduced, `prefix ${sample} suffix`)
				if (label === removedLabel) {
					// The one pattern that could have caught this fixture is gone —
					// the secret must now survive redaction.
					expect(out).toContain(sample)
				} else {
					// Every OTHER label's pattern is still present and must still
					// fire on its own fixture; this is what proves the two
					// lookahead adjustments did not cost coverage anywhere else.
					expect(out).not.toContain(sample)
				}
			}
		},
	)
})

describe('OUTPUT_SECRET_PATTERNS is untouched by the union', () => {
	it('still has exactly the original eight labels, in the original order', () => {
		expect(OUTPUT_SECRET_PATTERNS.map(([label]) => label)).toEqual([
			'aws-access-key',
			'github-token',
			'openai-key',
			'anthropic-key',
			'slack-token',
			'google-api-key',
			'private-key-block',
			'jwt',
		])
	})
})

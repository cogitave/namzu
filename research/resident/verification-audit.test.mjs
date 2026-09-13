import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { auditVerification } from './verification-audit.mjs'

const fixture = JSON.parse(
	readFileSync(new URL('./verification-results.json', import.meta.url), 'utf8'),
)
test('recorded verification and continuity evidence is internally consistent', () => {
	assert.equal(auditVerification(fixture).liveTokens, fixture.providerTokens)
})
const complete = (copy) => copy.trials.find((t) => t.kind === 'cases').cases[0]
for (const [name, mutate] of [
	[
		'answer substituted',
		(copy) => {
			complete(copy).terminals.at(-1).result += ' '
		},
	],
	[
		'foreign claim',
		(copy) => {
			complete(copy).finishes[0].claimId = 'foreign'
		},
	],
	[
		'source bytes changed',
		(copy) => {
			complete(copy).sources['package.json'] += ' '
		},
	],
	[
		'false checked value',
		(copy) => {
			complete(copy).finishes[0].verification.receipt.claims.version = 'old'
		},
	],
	[
		'completion without receipt',
		(copy) => {
			complete(copy).finishes[0].verification = null
		},
	],
	[
		'usage omitted',
		(copy) => {
			complete(copy).providerTokens += 1
		},
	],
	[
		'wake input lost',
		(copy) => {
			copy.trials
				.find((t) => t.kind === 'continuity')
				.requests.find((r) => r.epoch === 1).waveMarkers = []
		},
	],
	[
		'cancelled output fabricated',
		(copy) => {
			copy.trials
				.find((t) => t.kind === 'continuity')
				.finishes.find((f) => f.decision === null).usage = { totalTokens: 0 }
		},
	],
])
	test(`audit rejects ${name}`, () => {
		const copy = structuredClone(fixture)
		mutate(copy)
		assert.throws(() => auditVerification(copy))
	})

import { describe, expect, it } from 'vitest'
import type { HarnessTrial, HarnessVerificationBatch } from '../../eval/harness-verification.js'
import type { CaseResult } from '../../eval/types.js'
import {
	hashResidentSkill,
	projectResidentLearning,
	promoteResidentSkill,
	restoreResidentSkill,
	reviseResidentProfile,
} from './learning.js'

function evidence(key: string) {
	return { key, source: 'host:fixture', reason: 'Checked against the retained fixture evidence.' }
}

function skill(body = 'Read the source and cite the observed result.') {
	return { name: 'careful-research', description: 'Ground a finding in its source.', body }
}

function result(task: string, passed: boolean): CaseResult {
	return {
		case: task,
		status: passed ? 'passed' : 'failed',
		passed,
		mean: Number(passed),
		scores: { exact: { score: Number(passed), reason: 'Observed deterministic fixture outcome.' } },
		run: {
			output: passed ? 'Verified' : 'Missing evidence',
			steps: [],
			toolCalls: [],
			stopReason: 'end_turn',
			totalTokens: 0,
			totalCostUsd: 0,
			durationMs: 1,
		},
	}
}

function batch(
	prefix: string,
	baselineRevision: string,
	candidateRevision: string,
): HarnessVerificationBatch {
	const baseline: HarnessTrial[] = []
	const candidate: HarnessTrial[] = []
	for (let task = 0; task < 5; task++) {
		for (let trial = 0; trial < 2; trial++) {
			const shared = {
				taskId: `${prefix}-${task}`,
				trial,
				conditions: `${prefix}-${task}-${trial}`,
			}
			baseline.push({
				...shared,
				trajectoryId: `baseline-${shared.conditions}`,
				result: result(shared.taskId, task > 0),
			})
			candidate.push({
				...shared,
				trajectoryId: `candidate-${shared.conditions}`,
				result: result(shared.taskId, true),
			})
		}
	}
	const improvedTask = `${prefix}-0`
	return {
		baselineRevision,
		candidateRevision,
		baseline,
		candidate,
		attributions: [
			{
				taskId: improvedTask,
				effect: 'improvement',
				reason: 'The candidate retains source evidence that the baseline omitted.',
				baselineTrajectories: baseline
					.filter((trial) => trial.taskId === improvedTask)
					.map((trial) => trial.trajectoryId),
				candidateTrajectories: candidate
					.filter((trial) => trial.taskId === improvedTask)
					.map((trial) => trial.trajectoryId),
			},
		],
	}
}

function evaluation(candidate = skill(), baselineRevision = 'none') {
	const digest = hashResidentSkill(candidate)
	return {
		verification: batch('verification', baselineRevision, digest),
		confirmation: batch('confirmation', baselineRevision, digest),
	}
}

describe('versioned resident preferences', () => {
	it('corrects the named previous evidence without mutating the original profile', () => {
		const first = reviseResidentProfile(undefined, {
			identity: 'A careful research assistant.',
			preferences: [{ key: 'response-language', value: 'English', supersedes: null }],
			evidence: evidence('operator-1'),
		})
		const next = reviseResidentProfile(first, {
			preferences: [{ key: 'response-language', value: 'Turkish', supersedes: 'operator-1' }],
			evidence: evidence('operator-2'),
		})

		expect(first.revision).toBe(1)
		expect(next.revision).toBe(2)
		expect(first.preferences[0]).toMatchObject({
			value: 'English',
			evidence: { key: 'operator-1' },
		})
		expect(next.preferences[0]).toMatchObject({ value: 'Turkish', evidence: { key: 'operator-2' } })
		expect(next.identity).toEqual(first.identity)
		expect(next.lastChange.key).toBe('operator-2')
	})

	it('refuses an unacknowledged correction, stale supersession and recycled evidence', () => {
		const current = reviseResidentProfile(undefined, {
			identity: 'A careful researcher.',
			preferences: [{ key: 'style', value: 'Concise', supersedes: null }],
			evidence: evidence('observed-style'),
		})
		for (const supersedes of [null, 'another-observation']) {
			expect(() =>
				reviseResidentProfile(current, {
					preferences: [{ key: 'style', value: 'Detailed', supersedes }],
					evidence: evidence('new-style'),
				}),
			).toThrow()
		}
		expect(() =>
			reviseResidentProfile(current, {
				preferences: [{ key: 'style', value: 'Detailed', supersedes: 'observed-style' }],
				evidence: evidence('observed-style'),
			}),
		).toThrow()
		expect(() =>
			reviseResidentProfile(current, {
				identity: 'A completely different role.',
				evidence: evidence('observed-style'),
			}),
		).toThrow()
		expect(() =>
			reviseResidentProfile(current, {
				preferences: [{ key: 'new-preference', value: 'Value', supersedes: 'absent-fact' }],
				evidence: evidence('new-fact'),
			}),
		).toThrow()
	})

	it('refuses duplicate keys and bounds preferences, identity and values', () => {
		const proof = evidence('bounded-profile')
		expect(() =>
			reviseResidentProfile(undefined, {
				preferences: [
					{ key: 'style', value: 'Short', supersedes: null },
					{ key: 'style', value: 'Long', supersedes: null },
				],
				evidence: proof,
			}),
		).toThrow()
		const preferences = Array.from({ length: 32 }, (_, index) => ({
			key: `preference-${index}`,
			value: `value-${index}`,
			supersedes: null,
		}))
		const full = reviseResidentProfile(undefined, { preferences, evidence: proof })
		expect(full.preferences).toHaveLength(32)
		expect(() =>
			reviseResidentProfile(full, {
				preferences: [{ key: 'overflow', value: 'No room', supersedes: null }],
				evidence: evidence('overflow'),
			}),
		).toThrow()
		expect(() =>
			reviseResidentProfile(undefined, { identity: 'x'.repeat(4_001), evidence: proof }),
		).toThrow()
		expect(() =>
			reviseResidentProfile(undefined, {
				preferences: [{ key: 'oversized', value: 'x'.repeat(1_001), supersedes: null }],
				evidence: proof,
			}),
		).toThrow()
	})

	it.each(['key', 'source', 'reason'] as const)('requires a nonempty evidence %s', (field) => {
		expect(() =>
			reviseResidentProfile(undefined, {
				identity: 'A careful assistant.',
				evidence: { ...evidence('observation'), [field]: '   ' },
			}),
		).toThrow()
	})

	it('owns a defensive snapshot of incoming preference and evidence objects', () => {
		const input = {
			identity: 'A careful assistant.',
			preferences: [{ key: 'style', value: 'Concise', supersedes: null }],
			evidence: evidence('source-before'),
		}
		const retained = reviseResidentProfile(undefined, input)
		const preference = input.preferences[0]
		if (!preference) throw new Error('Missing preference fixture.')
		preference.value = 'Changed after commit'
		input.evidence.key = 'source-after'
		input.evidence.source = 'unrelated-source'
		expect(retained.preferences[0]).toMatchObject({
			value: 'Concise',
			evidence: { key: 'source-before' },
		})
		expect(retained.identity?.evidence.key).toBe('source-before')
		expect(retained.lastChange.source).toBe('host:fixture')
	})
})

describe('evaluated resident skills', () => {
	it('hashes the validated named content deterministically and detects content changes', () => {
		const candidate = skill()
		const hash = hashResidentSkill(candidate)
		expect(hash).toMatch(/^[a-f0-9]{64}$/)
		expect(
			hashResidentSkill({
				body: candidate.body,
				name: candidate.name,
				description: candidate.description,
			}),
		).toBe(hash)
		expect(hashResidentSkill(skill('A different instruction.'))).not.toBe(hash)
		expect(() => hashResidentSkill({ ...candidate, name: '   ' })).toThrow()
		expect(() => hashResidentSkill({ ...candidate, body: '   ' })).toThrow()
	})

	it('activates only the exact evaluated content and keeps independent snapshots', () => {
		const candidate = skill()
		const proof = evidence('verified-candidate')
		const profile = reviseResidentProfile(undefined, {
			identity: 'Research assistant',
			preferences: [{ key: 'style', value: 'Concise', supersedes: null }],
			evidence: evidence('profile'),
		})
		const original = structuredClone(profile)
		const expectedHash = hashResidentSkill(candidate)
		const promoted = promoteResidentSkill(profile, candidate, evaluation(candidate), proof)
		expect(promoted.revision).toBe(profile.revision + 1)
		expect(promoted.skills).toHaveLength(1)
		expect(promoted.skills[0]).toMatchObject({ ...candidate, hash: expectedHash, evidence: proof })
		expect(promoted.preferences).toEqual(profile.preferences)
		expect(promoted.identity).toEqual(profile.identity)
		expect(profile).toEqual(original)
		candidate.body = 'Changed after validation'
		proof.key = 'changed-proof'
		expect(promoted.skills[0]?.body).toBe(skill().body)
		expect(promoted.skills[0]?.evidence.key).toBe('verified-candidate')
	})

	it.each(['verification', 'confirmation'] as const)(
		'rejects %s evidence for another candidate hash',
		(phase) => {
			const candidate = skill()
			const tested = evaluation(candidate)
			tested[phase].candidateRevision = hashResidentSkill(skill('An unrelated candidate.'))
			expect(() =>
				promoteResidentSkill(undefined, candidate, tested, evidence('wrong-digest')),
			).toThrow()
		},
	)

	it('requires comparisons against the currently active skill in both evidence rounds', () => {
		const original = skill()
		const active = promoteResidentSkill(
			undefined,
			original,
			evaluation(original),
			evidence('first'),
		)
		const replacement = skill('Read, cross-check and cite the source.')
		const baseline = hashResidentSkill(original)
		for (const phase of ['verification', 'confirmation'] as const) {
			const stale = evaluation(replacement, baseline)
			stale[phase].baselineRevision = 'none'
			expect(() => promoteResidentSkill(active, replacement, stale, evidence('stale'))).toThrow()
		}
		const updated = promoteResidentSkill(
			active,
			replacement,
			evaluation(replacement, baseline),
			evidence('second'),
		)
		expect(updated.skills).toHaveLength(1)
		expect(updated.skills[0]?.hash).toBe(hashResidentSkill(replacement))
		expect(active.skills[0]?.hash).toBe(baseline)
	})

	it.each(['missing-confirmation', 'regression', 'unavailable', 'unattributed'] as const)(
		'leaves promotion inactive when the existing harness review reports %s',
		(fault) => {
			const candidate = skill()
			const tested = evaluation(candidate)
			if (fault === 'missing-confirmation') {
				expect(() =>
					promoteResidentSkill(
						undefined,
						candidate,
						{ verification: tested.verification },
						evidence('inconclusive'),
					),
				).toThrow()
				return
			}
			if (fault === 'regression') {
				for (const trial of tested.verification.candidate.filter(
					(trial) => trial.taskId === 'verification-1',
				)) {
					trial.result = result(trial.taskId, false)
				}
			} else if (fault === 'unavailable') {
				const score = tested.verification.candidate[0]?.result.scores.exact
				if (!score) throw new Error('Missing candidate measurement fixture.')
				score.unavailable = true
			} else {
				tested.verification.attributions = []
			}
			expect(() =>
				promoteResidentSkill(undefined, candidate, tested, evidence('rejected')),
			).toThrow()
		},
	)

	it('rolls back as a new revision while preserving current preferences and identity', () => {
		const original = skill()
		const first = promoteResidentSkill(undefined, original, evaluation(original), evidence('first'))
		const replacement = skill('A verified revised procedure.')
		const second = promoteResidentSkill(
			first,
			replacement,
			evaluation(replacement, hashResidentSkill(original)),
			evidence('second'),
		)
		const current = reviseResidentProfile(second, {
			identity: 'The current research identity.',
			preferences: [{ key: 'language', value: 'Turkish', supersedes: null }],
			evidence: evidence('new-profile'),
		})
		const restored = restoreResidentSkill(current, first, original.name, evidence('rollback'))
		expect(restored.revision).toBe(current.revision + 1)
		expect(restored.skills[0]?.hash).toBe(first.skills[0]?.hash)
		expect(restored.preferences).toEqual(current.preferences)
		expect(restored.identity).toEqual(current.identity)
		expect(restored.lastChange.key).toBe('rollback')
		expect(current.skills[0]?.hash).toBe(hashResidentSkill(replacement))
		const removed = restoreResidentSkill(restored, undefined, original.name, evidence('disable'))
		expect(removed.revision).toBe(restored.revision + 1)
		expect(removed.skills).toEqual([])
		expect(removed.preferences).toEqual(current.preferences)
		expect(removed.identity).toEqual(current.identity)
	})
})

describe('bounded resident learning projection', () => {
	it('includes only named skills and counts missing selections even without a profile', () => {
		expect(
			projectResidentLearning(undefined, { maxChars: 1_000, skillNames: ['missing'] }),
		).toEqual({
			text: '',
			revision: null,
			includedSkills: [],
			omitted: 1,
		})
		const candidate = skill()
		const current = promoteResidentSkill(
			undefined,
			candidate,
			evaluation(candidate),
			evidence('selected'),
		)
		const unselected = projectResidentLearning(current, { maxChars: 10_000, skillNames: [] })
		expect(unselected).toMatchObject({ text: '', includedSkills: [], omitted: 0 })
		const selected = projectResidentLearning(current, {
			maxChars: 10_000,
			skillNames: [candidate.name, 'missing'],
		})
		expect(selected.revision).toBe(current.revision)
		expect(selected.includedSkills).toEqual([candidate.name])
		expect(selected.omitted).toBe(1)
		expect(JSON.parse(selected.text)).toMatchObject({
			kind: 'evaluated-guidance',
			name: candidate.name,
			body: candidate.body,
			hash: hashResidentSkill(candidate),
		})
	})

	it('honors the exact UTF-16 character boundary without emitting partial instructions', () => {
		const candidate = skill('Önce kanıtı oku. 🔎\nSonra sonucu doğrula; belirsizse dur.')
		const current = promoteResidentSkill(
			undefined,
			candidate,
			evaluation(candidate),
			evidence('unicode'),
		)
		const full = projectResidentLearning(current, {
			maxChars: 10_000,
			skillNames: [candidate.name],
		})
		const exact = projectResidentLearning(current, {
			maxChars: full.text.length,
			skillNames: [candidate.name],
		})
		expect(exact.text).toBe(full.text)
		expect(JSON.parse(exact.text).body).toBe(candidate.body)
		expect(exact.omitted).toBe(0)
		const short = projectResidentLearning(current, {
			maxChars: full.text.length - 1,
			skillNames: [candidate.name],
		})
		expect(short).toMatchObject({ text: '', includedSkills: [], omitted: 1 })
	})

	it('keeps a smaller selected skill when an earlier instruction does not fit', () => {
		const large = { ...skill('x'.repeat(3_500)), name: 'large-guidance' }
		const small = { ...skill('Verify first.'), name: 'small-guidance' }
		const first = promoteResidentSkill(undefined, large, evaluation(large), evidence('large'))
		const current = promoteResidentSkill(first, small, evaluation(small), evidence('small'))
		const smallOnly = projectResidentLearning(current, {
			maxChars: 10_000,
			skillNames: [small.name],
		})
		const projected = projectResidentLearning(current, {
			maxChars: smallOnly.text.length,
			skillNames: [large.name, small.name],
		})
		expect(projected.text).toBe(smallOnly.text)
		expect(projected.includedSkills).toEqual([small.name])
		expect(projected.omitted).toBe(1)
		expect(projected.text.length).toBeLessThanOrEqual(smallOnly.text.length)
	})

	it('counts all omitted profile entries at zero budget and refreshes after correction and rollback', () => {
		const candidate = skill()
		const learned = promoteResidentSkill(
			undefined,
			candidate,
			evaluation(candidate),
			evidence('skill'),
		)
		const current = reviseResidentProfile(learned, {
			identity: 'A careful assistant.',
			preferences: [{ key: 'language', value: 'English', supersedes: null }],
			evidence: evidence('old-profile'),
		})
		expect(
			projectResidentLearning(current, { maxChars: 0, skillNames: [candidate.name, 'missing'] }),
		).toMatchObject({
			text: '',
			includedSkills: [],
			omitted: 4,
		})
		const corrected = reviseResidentProfile(current, {
			preferences: [{ key: 'language', value: 'Turkish', supersedes: 'old-profile' }],
			evidence: evidence('corrected-profile'),
		})
		const removed = restoreResidentSkill(
			corrected,
			undefined,
			candidate.name,
			evidence('disable-skill'),
		)
		const projected = projectResidentLearning(removed, {
			maxChars: 10_000,
			skillNames: [candidate.name],
		})
		const entries = projected.text.split('\n').map((line) => JSON.parse(line))
		expect(entries.find((entry) => entry.kind === 'preference')).toMatchObject({
			value: 'Turkish',
			evidence: { key: 'corrected-profile' },
		})
		expect(projected.revision).toBe(removed.revision)
		expect(projected.text).not.toContain('English')
		expect(projected.text).not.toContain(candidate.body)
		expect(projected.includedSkills).toEqual([])
		expect(projected.omitted).toBe(1)
	})

	it('rejects invalid budgets, duplicate selections and tampered evaluated content', () => {
		for (const maxChars of [-1, 1.5, Number.POSITIVE_INFINITY, 64_001]) {
			expect(() => projectResidentLearning(undefined, { maxChars, skillNames: [] })).toThrow()
		}
		expect(() =>
			projectResidentLearning(undefined, { maxChars: 100, skillNames: ['same', 'same'] }),
		).toThrow()
		const candidate = skill()
		const current = promoteResidentSkill(
			undefined,
			candidate,
			evaluation(candidate),
			evidence('verified'),
		)
		const tampered = structuredClone(current)
		const substituted = {
			...tampered,
			skills: tampered.skills.map((entry) => ({
				...entry,
				body: 'Different untested instructions.',
			})),
		}
		expect(() =>
			projectResidentLearning(substituted, { maxChars: 10_000, skillNames: [candidate.name] }),
		).toThrow()
	})
})

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateProjectId, generateTenantId } from '../utils/id.js'
import { SqliteLearningExperienceStore } from './experience-store.js'
import {
	type LearningExperienceInput,
	normalizeLearningExperience,
	selectLearningExperience,
} from './experience.js'
import { LearningLeakError, createLearningCanary } from './leak-tripwire.js'
import { hashLearningSkill } from './skill.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const candidate = {
	name: 'inspect',
	description: 'Look before editing.',
	body: 'Read the file in full before changing it, and say what you saw. '.repeat(20),
}
const evidence = [{ key: 'obs-1', source: 'session:turn', reason: 'The failing turn.' }]
const input = (over: Partial<LearningExperienceInput> = {}): LearningExperienceInput => ({
	domain: 'code-edit',
	cycleId: randomUUID(),
	evaluatorRevision: 'eval-v1',
	decision: 'adopted',
	reason: 'Passed paired verification.',
	candidate,
	edits: [
		{ component: 'instruction-skill', change: 'Added a read-first rule.', verdict: 'helped' },
	],
	lessons: [
		{
			cue: 'An edit follows a failed match.',
			lesson: 'Read the whole file first.',
			evidence,
			confidence: 'high',
			confidenceReason: 'Three of three paired tasks improved.',
			edits: [0],
		},
	],
	leakGuard: {},
	...over,
})

function store() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-experience-'))
	roots.push(root)
	return new SqliteLearningExperienceStore({
		databasePath: join(root, 'experience.sqlite'),
		scope: { tenantId: generateTenantId(), projectId: generateProjectId(), agentKey: 'default' },
	})
}

describe('normalizeLearningExperience', () => {
	it('keeps a single-component verdict and high confidence', () => {
		const entry = normalizeLearningExperience(input())
		expect(entry.edits[0]?.verdict).toBe('helped')
		expect(entry.lessons[0]?.confidence).toBe('high')
		expect(entry.candidateRevision).toBe(hashLearningSkill(candidate))
	})

	it('prefers confounded when several components changed together', () => {
		const entry = normalizeLearningExperience(
			input({
				edits: [
					{ component: 'instruction-skill', change: 'Read first.', verdict: 'helped' },
					{ component: 'tool-guidance', change: 'Prefer search.', verdict: 'hurt' },
					{ component: 'memory', change: 'Keep notes.', verdict: 'no observed effect' },
				],
			}),
		)
		expect(entry.edits.map((e) => e.verdict)).toEqual(['confounded', 'confounded', 'confounded'])
	})

	it('treats two edits to one component as changed together', () => {
		const entry = normalizeLearningExperience(
			input({
				edits: [
					{ component: 'instruction-skill', change: 'One.', verdict: 'helped' },
					{ component: 'instruction-skill', change: 'Two.', verdict: 'helped' },
				],
				lessons: [],
			}),
		)
		expect(entry.edits.map((e) => e.verdict)).toEqual(['confounded', 'confounded'])
	})

	it('narrows a lesson that cites no edits as resting on all of them', () => {
		const base = input().lessons?.[0]
		if (!base) throw new Error('fixture')
		const { edits: _omit, ...bare } = base
		const entry = normalizeLearningExperience(
			input({
				edits: [
					{ component: 'a', change: 'One.', verdict: 'helped' },
					{ component: 'b', change: 'Two.', verdict: 'helped' },
				],
				lessons: [bare],
			}),
		)
		expect(entry.lessons[0]?.confidence).toBe('low')
	})

	it('keeps the verdict of an edit that was tried alone', () => {
		const entry = normalizeLearningExperience(
			input({
				edits: [
					{
						component: 'instruction-skill',
						change: 'Read first.',
						verdict: 'helped',
						isolated: true,
					},
					{ component: 'memory', change: 'Keep notes.', verdict: 'helped' },
				],
				lessons: [],
			}),
		)
		expect(entry.edits.map((e) => e.verdict)).toEqual(['helped', 'confounded'])
	})

	it('narrows a lesson that rests on a confounded edit and says why', () => {
		const edits = [
			{
				component: 'instruction-skill',
				change: 'Read first.',
				verdict: 'helped' as const,
				isolated: true,
			},
			{ component: 'memory', change: 'Keep notes.', verdict: 'helped' as const },
		]
		const lesson = (refs: number[]) => ({
			cue: 'cue',
			lesson: 'lesson',
			evidence,
			confidence: 'high' as const,
			confidenceReason: 'It worked.',
			edits: refs,
		})
		const entry = normalizeLearningExperience(
			input({ edits, lessons: [lesson([0]), lesson([0, 1]), lesson([1])] }),
		)
		expect(entry.lessons.map((l) => l.confidence)).toEqual(['high', 'medium', 'low'])
		expect(entry.lessons[1]?.confidenceReason).toMatch(/Narrowed to medium/)
		expect(entry.lessons[2]?.confidenceReason).toMatch(/Narrowed to low/)
	})

	it('never raises a low confidence and refuses a lesson with no evidence or a missing edit', () => {
		const base = input().lessons?.[0]
		if (!base) throw new Error('fixture')
		const low = normalizeLearningExperience(input({ lessons: [{ ...base, confidence: 'low' }] }))
		expect(low.lessons[0]?.confidence).toBe('low')
		expect(() =>
			normalizeLearningExperience(input({ lessons: [{ ...base, evidence: [] }] })),
		).toThrow()
		expect(() =>
			normalizeLearningExperience(input({ lessons: [{ ...base, edits: [5] }] })),
		).toThrow(/absent/)
	})
})

describe('SqliteLearningExperienceStore', () => {
	it('stores the whole artefact, not a summary', async () => {
		const s = store()
		const recorded = await s.record(input())
		const [read] = await s.retrieve({
			domain: 'code-edit',
			evaluatorRevision: 'eval-v1',
			beforeOrdinal: recorded.ordinal + 1,
			leakGuard: {},
		})
		expect(read?.candidate.body).toBe(candidate.body.trim())
		expect(read?.candidate.description).toBe(candidate.description)
	})

	it('retrieves within one domain, one evaluator revision and only from earlier entries', async () => {
		const s = store()
		const a = await s.record(input())
		await s.record(input({ domain: 'shell', cycleId: randomUUID() }))
		await s.record(input({ evaluatorRevision: 'eval-v2', cycleId: randomUUID() }))
		const c = await s.record(input({ decision: 'rejected', cycleId: randomUUID() }))
		const later = await s.record(input({ cycleId: randomUUID() }))
		const query = { domain: 'code-edit', evaluatorRevision: 'eval-v1', leakGuard: {} }
		const seenByC = await s.retrieve({ ...query, beforeOrdinal: c.ordinal })
		expect(seenByC.map((e) => e.ordinal)).toEqual([a.ordinal])
		const all = await s.retrieve({ ...query, beforeOrdinal: later.ordinal + 1 })
		expect(all.map((e) => e.ordinal)).toEqual([later.ordinal, c.ordinal, a.ordinal])
		const rejected = await s.retrieve({
			...query,
			beforeOrdinal: later.ordinal + 1,
			decision: 'rejected',
		})
		expect(rejected.map((e) => e.ordinal)).toEqual([c.ordinal])
		expect(await s.nextOrdinal()).toBe(later.ordinal + 1)
	})

	it('is idempotent for identical content and refuses a different entry for the same cycle', async () => {
		const s = store()
		const same = input()
		const first = await s.record(same)
		const again = await s.record(same)
		expect(again.ordinal).toBe(first.ordinal)
		await expect(s.record({ ...same, reason: 'Something else.' })).rejects.toThrow(/immutable/)
	})

	it('refuses an entry that carries evaluator-side material without repeating it', async () => {
		const s = store()
		const canary = createLearningCanary()
		const error = await s
			.record(
				input({
					reason: `Seen ${canary} in the answer key.`,
					leakGuard: { canaries: [canary] },
				}),
			)
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(LearningLeakError)
		expect((error as Error).message).not.toContain(canary)
		expect(await s.nextOrdinal()).toBe(1)
	})
})

describe('leak coverage and the required guard', () => {
	const canary = createLearningCanary()
	const guard = { canaries: [canary] }
	const planted: [string, Partial<LearningExperienceInput>][] = [
		[
			'edit component',
			{ edits: [{ component: `c ${canary}`, change: 'Read first.', verdict: 'helped' }] },
		],
		['evaluatorRevision', { evaluatorRevision: `rev ${canary}` }],
		['candidate name', { candidate: { ...candidate, name: `n-${canary}` } }],
		['domain', { domain: canary.toLowerCase() }],
		[
			'lesson evidence',
			{
				lessons: [
					{
						cue: 'cue',
						lesson: 'lesson',
						evidence: [{ key: 'k', source: `s ${canary}`, reason: 'r' }],
						confidence: 'low',
						confidenceReason: 'r',
					},
				],
			},
		],
	]
	for (const [field, over] of planted) {
		it(`finds a canary in ${field}`, async () => {
			await expect(store().record(input({ ...over, leakGuard: guard }))).rejects.toBeInstanceOf(
				LearningLeakError,
			)
		})
	}

	it('refuses to record or retrieve without a guard', async () => {
		const s = store()
		const bad = input({ leakGuard: undefined as never })
		await expect(s.record(bad)).rejects.toThrow(/leakGuard/)
		await s.record(input())
		await expect(
			s.retrieve({
				domain: 'code-edit',
				evaluatorRevision: 'eval-v1',
				beforeOrdinal: 99,
				leakGuard: undefined as never,
			}),
		).rejects.toThrow(/leakGuard/)
	})

	it('scans again on retrieval, so an entry stored under a looser guard is not served', async () => {
		const s = store()
		await s.record(input({ reason: `saw ${canary}` }))
		await expect(
			s.retrieve({
				domain: 'code-edit',
				evaluatorRevision: 'eval-v1',
				beforeOrdinal: 99,
				leakGuard: guard,
			}),
		).rejects.toBeInstanceOf(LearningLeakError)
	})

	it('scopes nextOrdinal to the store scope', async () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-experience-'))
		roots.push(root)
		const databasePath = join(root, 'experience.sqlite')
		const make = () =>
			new SqliteLearningExperienceStore({
				databasePath,
				scope: {
					tenantId: generateTenantId(),
					projectId: generateProjectId(),
					agentKey: 'default',
				},
			})
		const a = make()
		const b = make()
		await a.record(input())
		await a.record(input({ cycleId: randomUUID() }))
		expect(await b.nextOrdinal()).toBe(1)
	})
})

describe('selectLearningExperience', () => {
	it('returns nothing when the reader is the first entry', () => {
		expect(
			selectLearningExperience([], {
				domain: 'a',
				evaluatorRevision: 'r',
				beforeOrdinal: 1,
				leakGuard: {},
			}),
		).toEqual([])
	})
})

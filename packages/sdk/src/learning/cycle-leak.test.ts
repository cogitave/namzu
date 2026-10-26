import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiskResidentAgenda } from '../manager/resident/agenda.js'
import { generateTenantId } from '../utils/id.js'
import { type LearningCycleEvent, type LearningCycleOptions, runLearningCycle } from './cycle.js'
import { createLearningCanary } from './leak-tripwire.js'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

const skill = {
	name: 'inspect-source',
	description: 'Ground the finding.',
	body: 'Read the designated source before reporting its value.',
}
const evidence = { key: 'missing-source', source: 'fixture:trace', reason: 'No source read.' }

async function fixture(canary: string, over: Partial<LearningCycleOptions> = {}) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-leak-cycle-'))
	roots.push(root)
	const agenda = new DiskResidentAgenda(root, {
		tenantId: generateTenantId(),
		agentKey: 'leak-test',
	})
	await agenda.create('Learn only from clean evidence.')
	const events: LearningCycleEvent[] = []
	const called: string[] = []
	const options: LearningCycleOptions = {
		protection: { verification: ['v-1'], confirmation: ['c-1'] },
		agenda,
		skillName: skill.name,
		failure: { evidence, trace: 'Expected a supported value, observed an unsupported one.' },
		leakGuard: { canaries: [canary] },
		signal: new AbortController().signal,
		resources: { unit: 'tokens', maxUnits: 100 },
		record: async (event) => {
			events.push(structuredClone(event))
		},
		generate: async (context) => {
			called.push('generate')
			await context.recordUsage({
				sessionId: randomUUID(),
				turnId: randomUUID(),
				tokens: 5,
				costUsd: null,
			})
			return { candidate: skill, usageComplete: true }
		},
		evaluate: async () => {
			called.push('evaluate')
			throw new Error('evaluation must not be reached')
		},
		...over,
	}
	return { options, events, called }
}

describe('learning cycle leak tripwire', () => {
	it('refuses evidence that carries a canary before any stage runs or anything is journaled', async () => {
		const canary = createLearningCanary()
		const f = await fixture(canary, {
			failure: { evidence, trace: `the model saw ${canary} in the rubric` },
		})
		const result = await runLearningCycle(f.options)
		expect(result.status).toBe('failed')
		expect(result.reason).toContain('a leak, not a false positive')
		expect(result.leak).toEqual([{ kind: 'canary', subject: 'failure.trace', rule: 'canary[0]' }])
		expect(f.called).toEqual([])
		expect(f.events.some((e) => e.kind === 'started')).toBe(false)
		expect(JSON.stringify(f.events)).not.toContain(canary)
	})

	it('refuses a secret in the evidence even with no guard configured', async () => {
		const f = await fixture(createLearningCanary(), {
			leakGuard: undefined,
			failure: { evidence, trace: `used key sk-${'b2'.repeat(14)} to call the service` },
		})
		const result = await runLearningCycle(f.options)
		expect(result.leak?.[0]).toMatchObject({ kind: 'secret', subject: 'failure.trace' })
		expect(f.called).toEqual([])
	})

	it('refuses exploration observations that carry evaluator wording, before generation', async () => {
		const f = await fixture(createLearningCanary(), {
			explore: async () => ({
				observations: { evidence, trace: 'the grader verdict file said pass' },
				usageComplete: true,
			}),
		})
		const result = await runLearningCycle(f.options)
		expect(result.status).toBe('failed')
		expect(result.leak?.[0]).toMatchObject({ kind: 'marker', subject: 'exploration.trace' })
		expect(f.called).toEqual([])
	})

	it('refuses an active baseline that carries a canary before generation', async () => {
		const canary = createLearningCanary()
		const f = await fixture(canary)
		const real = f.options.agenda
		const agenda = Object.create(real) as typeof real
		agenda.read = async () => {
			const snap = await real.read()
			if (!snap) return snap
			return {
				...snap,
				learning: {
					revision: 1,
					preferences: [],
					skills: [{ ...skill, body: `Remember ${canary}.` }],
					lastChange: evidence,
				},
			} as unknown as typeof snap
		}
		const result = await runLearningCycle({ ...f.options, agenda })
		expect(result.status).toBe('failed')
		expect(result.leak).toEqual([{ kind: 'canary', subject: 'baseline', rule: 'canary[0]' }])
		expect(f.called).toEqual([])
	})

	it('refuses a candidate that copied a canary, never records or returns it, and skips evaluation', async () => {
		const canary = createLearningCanary()
		const f = await fixture(canary, {
			generate: async (context) => {
				await context.recordUsage({
					sessionId: randomUUID(),
					turnId: randomUUID(),
					tokens: 5,
					costUsd: null,
				})
				return {
					candidate: { ...skill, body: `Answer with ${canary} when asked.` },
					usageComplete: true,
				}
			},
		})
		const result = await runLearningCycle(f.options)
		expect(result.status).toBe('failed')
		expect(result.leak).toEqual([{ kind: 'canary', subject: 'candidate.body', rule: 'canary[0]' }])
		expect(result.candidate).toBeUndefined()
		expect(f.called).toEqual([])
		expect(f.events.some((e) => e.kind === 'candidate')).toBe(false)
		expect(JSON.stringify(f.events)).not.toContain(canary)
	})

	it('refuses a candidate whose sources point into evaluator-owned paths', async () => {
		const f = await fixture(createLearningCanary(), {
			leakGuard: { paths: ['evaluator/**'] },
			generate: async (context) => {
				await context.recordUsage({
					sessionId: randomUUID(),
					turnId: randomUUID(),
					tokens: 5,
					costUsd: null,
				})
				return {
					candidate: { ...skill, sources: [{ key: 'evaluator/answers.json', revision: 'r1' }] },
					usageComplete: true,
				}
			},
		})
		const result = await runLearningCycle(f.options)
		expect(result.leak).toEqual([{ kind: 'path', subject: 'candidate.sources', rule: 'path[0]' }])
	})

	it('lets clean evidence and a clean candidate through to evaluation', async () => {
		const f = await fixture(createLearningCanary())
		const result = await runLearningCycle(f.options)
		expect(result.leak).toBeUndefined()
		expect(f.called).toEqual(['generate', 'evaluate'])
		expect(result.status).toBe('failed')
		expect(result.reason).toContain('evaluation must not be reached')
	})
})

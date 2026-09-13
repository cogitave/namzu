import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessTrial, HarnessVerificationBatch } from '../../eval/harness-verification.js'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { ResidentHost } from './host.js'
import {
	type ResidentLearningCycleEvent,
	type ResidentLearningCycleOptions,
	type ResidentLearningEvaluationContext,
	runResidentLearningCycle,
} from './learning-cycle.js'
import { hashResidentSkill, projectResidentLearning } from './learning.js'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
const skill = {
	name: 'inspect-source',
	description: 'Ground the finding.',
	body: 'Read the designated source before reporting its value.',
}
const evidence = {
	key: 'missing-source',
	source: 'fixture:trace',
	reason: 'The observed output had no supporting source read.',
}

function batch(
	context: ResidentLearningEvaluationContext,
	mode: 'better' | 'regress' | 'equal' = 'better',
): HarnessVerificationBatch {
	const trials = (side: string): HarnessTrial[] =>
		Array.from({ length: 10 }, (_, i) => {
			const taskId = `${context.stage}-${Math.floor(i / 2)}`
			const passed =
				mode === 'equal' ||
				(mode === 'better' ? side === 'candidate' || i > 1 : side === 'baseline')
			return {
				taskId,
				trial: i % 2,
				conditions: `${context.stage}-${i}`,
				trajectoryId: `${side}-${context.stage}-${i}`,
				result: {
					case: taskId,
					passed,
					status: passed ? 'passed' : 'failed',
					mean: Number(passed),
					scores: {
						exact: {
							score: Number(passed),
							reason: 'Compared the output with the fixture source.',
						},
					},
					run: {
						output: passed ? 'supported' : 'unsupported',
						steps: [],
						toolCalls: [],
						totalTokens: 1,
						totalCostUsd: 0,
						durationMs: 1,
					},
				},
			}
		})
	const baseline = trials('baseline')
	const candidate = trials('candidate')
	return {
		baselineRevision: context.baselineRevision,
		candidateRevision: context.candidateRevision,
		baseline,
		candidate,
		attributions:
			mode === 'equal'
				? []
				: [
						{
							taskId: `${context.stage}-0`,
							effect: mode === 'better' ? 'improvement' : 'regression',
							reason: 'Independent fixture source/output comparison.',
							baselineTrajectories: baseline.slice(0, 2).map((t) => t.trajectoryId),
							candidateTrajectories: candidate.slice(0, 2).map((t) => t.trajectoryId),
						},
					],
	}
}

async function snapshot(agenda: DiskResidentAgenda) {
	const state = await agenda.read()
	if (!state) throw new Error('Missing fixture agenda.')
	return state
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-learning-cycle-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'learning-test' }
	const agenda = new DiskResidentAgenda(root, scope)
	const initial = await agenda.create('Inspect sources and learn only evaluated guidance.')
	const events: ResidentLearningCycleEvent[] = []
	const stages: string[] = []
	const controller = new AbortController()
	const options: ResidentLearningCycleOptions = {
		agenda,
		skillName: skill.name,
		failure: { evidence, trace: 'Expected supported source value, observed unsupported.' },
		signal: controller.signal,
		resources: { unit: 'tokens', maxUnits: 100 },
		record: async (event) => {
			events.push(structuredClone(event))
		},
		generate: async (context) => {
			stages.push(context.stage)
			await context.recordUsage({ runId: randomUUID(), tokens: 5, costUsd: null })
			return { candidate: skill, usageComplete: true }
		},
		evaluate: async (context) => {
			stages.push(context.stage)
			await context.recordUsage({ runId: randomUUID(), tokens: 20, costUsd: null })
			return { batch: batch(context), usageComplete: true }
		},
	}
	return { root, scope, agenda, initial, events, stages, controller, options }
}

describe('resident learning cycle', () => {
	it('generates, verifies, confirms and atomically activates exact guidance; reopening and rollback reach admitted context', async () => {
		const f = await fixture()
		const parentCycleId = randomUUID()
		const outcome = await runResidentLearningCycle({ ...f.options, parentCycleId })
		expect(outcome).toMatchObject({
			status: 'activated',
			candidateRevision: hashResidentSkill(skill),
			consumption: { tokens: 45, costUsd: 0, receipts: 3, unknownCosts: 3, unfinishedStages: 0 },
			auditComplete: true,
		})
		expect(f.stages).toEqual(['generate', 'verification', 'confirmation'])
		expect(f.events[0]).toMatchObject({
			kind: 'started',
			data: { parentCycleId, failure: f.options.failure, baselineRevision: 'none' },
		})
		expect(f.events.map((e) => e.sequence)).toEqual(f.events.map((_, i) => i + 1))
		expect(f.events.find((e) => e.kind === 'activation-requested')?.data.agendaRevision).toBe(
			f.initial.revision,
		)
		const reopened = new DiskResidentAgenda(f.root, f.scope)
		expect((await reopened.read())?.learning?.skills[0]?.hash).toBe(outcome.candidateRevision)
		const projections: string[][] = []
		await reopened.add(await snapshot(reopened), 'Inspect the current source.')
		const host = new ResidentHost(
			reopened,
			async (_p, _s, context) => {
				projections.push([
					...projectResidentLearning(context.learning, { maxChars: 4000, skillNames: [skill.name] })
						.includedSkills,
				])
				return { kind: 'complete', summary: 'Observed admitted skill.' }
			},
			{ learning: true },
		)
		await host.run({ signal: f.controller.signal, maxSteps: 1 })
		await reopened.rollbackSkill(await snapshot(reopened), skill.name, f.initial.revision, {
			...evidence,
			key: 'rollback',
		})
		await reopened.add(await snapshot(reopened), 'Inspect again after rollback.')
		await host.run({ signal: f.controller.signal, maxSteps: 1 })
		expect(projections).toEqual([[skill.name], []])
	})

	it.each(['regress', 'equal'] as const)(
		'does not spend a confirmation round on %s evidence',
		async (mode) => {
			const f = await fixture()
			const outcome = await runResidentLearningCycle({
				...f.options,
				evaluate: async (context) => {
					f.stages.push(context.stage)
					await context.recordUsage({ runId: randomUUID(), tokens: 20, costUsd: 0 })
					return { batch: batch(context, mode), usageComplete: true }
				},
			})
			expect(outcome.status).toBe('rejected')
			expect(f.stages).toEqual(['generate', 'verification'])
			expect(await f.agenda.read()).toEqual(f.initial)
		},
	)

	it('retains usage and rejects regressing confirmation', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			evaluate: async (context) => {
				await context.recordUsage({ runId: randomUUID(), tokens: 20, costUsd: null })
				return {
					batch: batch(context, context.stage === 'confirmation' ? 'regress' : 'better'),
					usageComplete: true,
				}
			},
		})
		expect(outcome).toMatchObject({ status: 'rejected', consumption: { tokens: 45 } })
		expect(await f.agenda.read()).toEqual(f.initial)
	})

	it('requires fresh confirmation conditions and identities', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			evaluate: async (context) => {
				await context.recordUsage({ runId: randomUUID(), tokens: 20, costUsd: null })
				return { batch: batch({ ...context, stage: 'verification' }), usageComplete: true }
			},
		})
		expect(outcome.status).toBe('inconclusive')
		expect(await f.agenda.read()).toEqual(f.initial)
	})

	it.each(['tokens', 'usd'] as const)(
		'stops on unknown %s without inferring free work',
		async (unit) => {
			const f = await fixture()
			const outcome = await runResidentLearningCycle({
				...f.options,
				resources: { unit, maxUnits: 100 },
				generate: async (context) => {
					await context.recordUsage({
						runId: randomUUID(),
						tokens: unit === 'tokens' ? null : 5,
						costUsd: null,
					})
					return { candidate: skill, usageComplete: true }
				},
			})
			expect(outcome.status).toBe('inconclusive')
			expect(f.stages).toEqual([])
			expect(outcome.consumption.unknownCosts).toBe(1)
		},
	)

	it('stops subsequent stages after exceeding the recorded allowance', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			resources: { unit: 'tokens', maxUnits: 4 },
		})
		expect(outcome).toMatchObject({ status: 'inconclusive', consumption: { tokens: 5 } })
		expect(f.stages).toEqual(['generate'])
	})

	it('retains partial consumption when an evaluation throws', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			evaluate: async (context) => {
				await context.recordUsage({ runId: randomUUID(), tokens: 8, costUsd: null })
				throw new Error('Provider transport failed during the next call.')
			},
		})
		expect(outcome).toMatchObject({
			status: 'failed',
			consumption: { tokens: 13, unfinishedStages: 1 },
			auditComplete: true,
		})
		expect(f.events.at(-1)).toMatchObject({
			kind: 'finished',
			data: {
				result: {
					status: 'failed',
					candidateRevision: hashResidentSkill(skill),
					consumption: { tokens: 13, unfinishedStages: 1 },
				},
			},
		})
		expect(await f.agenda.read()).toEqual(f.initial)
	})

	it('does not accept a stage that claims completeness without receipts', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			generate: async () => ({ candidate: skill, usageComplete: true }),
		})
		expect(outcome).toMatchObject({ status: 'inconclusive', consumption: { unfinishedStages: 1 } })
	})

	it('detects a duplicate UUID alias across stages without double-counting', async () => {
		const f = await fixture()
		const id = randomUUID()
		const outcome = await runResidentLearningCycle({
			...f.options,
			generate: async (context) => {
				await context.recordUsage({ runId: id, tokens: 5, costUsd: null })
				return { candidate: skill, usageComplete: true }
			},
			evaluate: async (context) => {
				await context.recordUsage({ runId: id.toUpperCase(), tokens: 5, costUsd: null })
				return { batch: batch(context), usageComplete: true }
			},
		})
		expect(outcome).toMatchObject({
			status: 'failed',
			consumption: { tokens: 5, receipts: 1, unfinishedStages: 1 },
		})
	})

	it('cancels after an uncooperative generator returns without evaluating or promoting', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			generate: async (context) => {
				await context.recordUsage({ runId: randomUUID(), tokens: 5, costUsd: null })
				f.controller.abort()
				return { candidate: skill, usageComplete: true }
			},
		})
		expect(outcome.status).toBe('cancelled')
		expect(await f.agenda.read()).toEqual(f.initial)
	})

	it('stops before another expensive callback when the agenda changed', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			generate: async (context) => {
				const value = await f.options.generate(context)
				await f.agenda.add(f.initial, 'Unrelated new work changed the agenda.')
				return value
			},
		})
		expect(outcome.status).toBe('conflict')
		expect(f.stages).toEqual(['generate'])
		expect((await f.agenda.read())?.learning).toBeUndefined()
	})

	it('does not misreport committed activation when the terminal journal append fails', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			record: async (event) => {
				if (event.kind === 'finished') throw new Error('Disk full after commit.')
				await f.options.record(event)
			},
		})
		expect(outcome).toMatchObject({ status: 'activated', auditComplete: false })
		expect((await f.agenda.read())?.learning?.skills[0]?.hash).toBe(outcome.candidateRevision)
	})

	it('does not run inference if the initial journal append fails', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			record: async () => {
				throw new Error('No durable journal.')
			},
		})
		expect(outcome).toMatchObject({ status: 'failed', auditComplete: false })
		expect(f.stages).toEqual([])
	})

	it('reports an unknown activation when a store commits and loses the response', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			agenda: {
				read: () => f.agenda.read(),
				promoteSkill: async (...args) => {
					await f.agenda.promoteSkill(...args)
					throw new Error('Lost commit acknowledgement.')
				},
			},
		})
		expect(outcome.status).toBe('activation-unknown')
		expect((await f.agenda.read())?.learning?.skills[0]?.hash).toBe(outcome.candidateRevision)
	})

	it('rejects mismatched evaluated content before promotion', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			evaluate: async (context) => {
				const value = await f.options.evaluate(context)
				return { ...value, batch: { ...value.batch, candidateRevision: 'another candidate' } }
			},
		})
		expect(outcome.status).toBe('failed')
		expect(await f.agenda.read()).toEqual(f.initial)
	})

	it('stops when a callback catches a rejected usage receipt', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			generate: async (context) => {
				const receipt = { runId: randomUUID(), tokens: 5, costUsd: null }
				await context.recordUsage(receipt)
				await context.recordUsage(receipt).catch(() => undefined)
				return { candidate: skill, usageComplete: true }
			},
		})
		expect(outcome.status).toBe('failed')
		expect(await f.agenda.read()).toEqual(f.initial)
	})

	it('rejects inconsistent trial success before attempting a commit', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			evaluate: async (context) => {
				const value = await f.options.evaluate(context)
				const trial = value.batch.candidate[0]
				if (!trial) throw new Error('Missing candidate fixture.')
				trial.result.passed = false
				return value
			},
		})
		expect(outcome.status).toBe('failed')
		expect(f.events.some((e) => e.kind === 'activation-requested')).toBe(false)
		expect(await f.agenda.read()).toEqual(f.initial)
	})

	it('does not generate while the agenda is paused', async () => {
		const f = await fixture()
		await f.agenda.setPaused(f.initial, true)
		const outcome = await runResidentLearningCycle(f.options)
		expect(outcome.status).toBe('failed')
		expect(f.stages).toEqual([])
	})

	it('does not admit more work with zero remaining recorded allowance', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			resources: { unit: 'tokens', maxUnits: 5 },
		})
		expect(outcome.status).toBe('inconclusive')
		expect(f.stages).toEqual(['generate'])
	})

	it('observes cancellation during journal IO before calling the generator', async () => {
		const f = await fixture()
		const outcome = await runResidentLearningCycle({
			...f.options,
			record: async (event) => {
				await f.options.record(event)
				if (event.kind === 'stage-started') f.controller.abort()
			},
		})
		expect(outcome.status).toBe('cancelled')
		expect(f.stages).toEqual([])
	})
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type HarnessTrial,
	type HarnessVerificationBatch,
	type LearningSkillCandidate,
	SessionPaths,
	generateTenantId,
	hashLearningSkill,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { openProjectGuidance, readProjectGuidance } from './project-guidance.js'

type CaseResult = HarnessTrial['result']

const roots: string[] = []
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

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
		turn: {
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

function evaluation(candidate: LearningSkillCandidate = skill(), baselineRevision = 'none') {
	const digest = hashLearningSkill(candidate)
	return {
		protection: { verification: ['verification-1'], confirmation: ['confirmation-1'] },
		verification: batch('verification', baselineRevision, digest),
		confirmation: batch('confirmation', baselineRevision, digest),
	}
}

describe('project guidance', () => {
	const setup = () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-guidance-'))
		roots.push(home)
		return {
			paths: new SessionPaths({ home, slug: 'proj' }),
			tenantId: generateTenantId() as string,
		}
	}

	it('is absent until something is activated and reading never creates state', async () => {
		const { paths, tenantId } = setup()
		expect(await readProjectGuidance(paths, tenantId)).toBeNull()
		await openProjectGuidance(paths, tenantId)
		expect(await readProjectGuidance(paths, tenantId)).toBeNull()
	})

	it('hands later conversations the guidance a confirmed experiment activated', async () => {
		const { paths, tenantId } = setup()
		const agenda = await openProjectGuidance(paths, tenantId)
		const candidate = skill('Check the file exists before editing it.')
		const state = await agenda.read()
		if (!state) throw new Error('agenda missing')
		await agenda.promoteSkill(state, candidate, evaluation(candidate), evidence('activate'))
		const text = await readProjectGuidance(paths, tenantId)
		expect(text).toContain('Check the file exists before editing it.')
		expect(text).toContain('not a permission')
	})

	it('never hands a conversation an exploration policy', async () => {
		const { paths, tenantId } = setup()
		const agenda = await openProjectGuidance(paths, tenantId)
		const policy = { ...skill(), purpose: 'exploration' as const }
		const state = await agenda.read()
		if (!state) throw new Error('agenda missing')
		await agenda.promoteSkill(state, policy, evaluation(policy), evidence('policy'))
		expect(await readProjectGuidance(paths, tenantId)).toBeNull()
	})
})

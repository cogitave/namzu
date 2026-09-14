import { describe, expect, it } from 'vitest'
import { type ResidentLearningState, hashResidentSkill } from '../../manager/resident/learning.js'
import type { ResidentState } from '../../manager/resident/store.js'
import type { ToolContext } from '../../types/tool/index.js'
import { generateRunId } from '../../utils/id.js'
import { createResidentStepContext } from '../resident-learning.js'

function state(overrides: Partial<ResidentState> = {}): ResidentState {
	return {
		tenantId: 'bc1544a4-3cab-4e24-86c2-01874d5f0c39',
		agentKey: 'reviewer',
		pursuitId: 'c4484567-e3b7-4928-82a2-5584a3d6980d',
		identity: 'A repository reviewer.',
		objective: 'Check both remaining acceptance criteria in the authorized fixture.',
		revision: 4,
		stepsAdmitted: 2,
		phase: 'running',
		wakeAt: null,
		reason: 'The second acceptance criterion is now available.',
		summary: 'The first criterion passed with receipt ALPHA-471. Verify the second criterion.',
		claimId: 'c110ae82-43e4-43c1-a7ad-3ad8d8f89d75',
		...overrides,
	}
}

function learning(): ResidentLearningState {
	const evidence = { key: 'approved-1', source: 'host:test', reason: 'Approved fixture guidance.' }
	const candidate = {
		name: 'checked-identifiers',
		description: 'Retain exact evidence identifiers.',
		body: 'Keep exact receipt identifiers and distinguish reported evidence from fresh observations.',
	}
	const hash = hashResidentSkill(candidate)
	return {
		revision: 1,
		identity: { text: 'An assistant that checks source evidence.', evidence },
		preferences: [{ key: 'report-style', value: 'Name acceptance criteria explicitly.', evidence }],
		skills: [
			{
				...candidate,
				hash,
				evidence,
				verification: {
					baselineHash: 'none',
					candidateHash: hash,
					evidenceDigest: 'a'.repeat(64),
					verificationTasks: 5,
					confirmationTasks: 5,
				},
			},
		],
		lastChange: evidence,
	}
}

const owner = generateRunId()
const context: ToolContext = {
	runId: owner,
	workingDirectory: '/tmp',
	abortSignal: new AbortController().signal,
	env: {},
	log() {},
}
const options = () => ({
	state: state(),
	learning: learning(),
	outputInstructions: 'Report the verified result.',
	authorizeLearningRead: (ctx: ToolContext) => ctx.runId === owner,
})
const rendered = (bundle: ReturnType<typeof createResidentStepContext>, placement: string) =>
	bundle.contributions
		.filter((c) => c.placement === placement)
		.map((c) => c.render({ iteration: 1 }))
		.filter(Boolean)
		.join('\n')

describe('resident guidance disclosure', () => {
	it('does not advertise or disclose explorer policies in a task admission', async () => {
		const input = options()
		const original = input.learning.skills[0]!
		const candidate = {
			...original,
			name: 'explorer-policy',
			purpose: 'exploration' as const,
			description: 'EXPLORER DESCRIPTION',
			body: 'EXPLORER BODY',
		}
		const hash = hashResidentSkill(candidate)
		const policy = {
			...candidate,
			hash,
			verification: { ...original.verification, candidateHash: hash },
		}
		input.learning = { ...input.learning, skills: [original, policy] }
		const bundle = createResidentStepContext(input)
		expect(rendered(bundle, 'dynamic')).not.toContain(policy.description)
		const read = await bundle.tools[0]!.execute({ name: policy.name }, context)
		expect(read.success).toBe(false)
		expect(read.output).toContain('different-purpose')
		expect(read.output).not.toContain(policy.body)
		expect(rendered(bundle, 'turn')).toBe('')
		const onlyPolicy = createResidentStepContext({
			...input,
			learning: { ...input.learning, skills: [policy] },
		})
		expect(onlyPolicy.tools).toEqual([])
		expect(rendered(onlyPolicy, 'dynamic')).not.toContain(policy.description)
	})
	it('advertises metadata without executing instructions and freezes the admitted content', async () => {
		const input = options()
		const body = input.learning.skills[0]!.body
		const bundle = createResidentStepContext(input)
		expect(rendered(bundle, 'static') + rendered(bundle, 'dynamic')).not.toContain(body)
		expect(rendered(bundle, 'dynamic')).toContain(input.learning.skills[0]!.description)
		expect(rendered(bundle, 'dynamic')).toContain('report-style')
		expect(rendered(bundle, 'turn')).toBe('')
		;(input.learning.skills[0] as { body: string }).body = 'CHANGED OUTSIDE ADMISSION'
		const result = await bundle.tools[0]!.execute({ name: 'checked-identifiers' }, context)
		expect(result.success).toBe(true)
		expect(result.output).toContain(body)
		expect(rendered(bundle, 'turn')).toContain(body)
		expect(rendered(bundle, 'dynamic')).not.toContain(body)
		expect(rendered(createResidentStepContext(options()), 'turn')).toBe('')
	})
	it('rejects foreign runs and unavailable names without selecting or leaking a body', async () => {
		const bundle = createResidentStepContext(options())
		const denied = await bundle.tools[0]!.execute(
			{ name: 'checked-identifiers' },
			{ ...context, runId: generateRunId() },
		)
		expect(denied.success).toBe(false)
		expect(denied.output).toBe('')
		expect((await bundle.tools[0]!.execute({ name: 'unknown' }, context)).success).toBe(false)
		expect(rendered(bundle, 'turn')).toBe('')
	})
	it('checks source bindings at read time and every subsequent request, including changed and missing sources', async () => {
		const input = options()
		const skill = input.learning.skills[0]!
		const candidate = { ...skill, sources: [{ key: 'host:source', revision: 'v1' }] }
		const hash = hashResidentSkill(candidate)
		input.learning = {
			...input.learning,
			skills: [
				{ ...candidate, hash, verification: { ...skill.verification, candidateHash: hash } },
			],
		}
		let sources: { key: string; revision: string }[] = []
		const bundle = createResidentStepContext({ ...input, resolveLearningSources: () => sources })
		const read = () => bundle.tools[0]!.execute({ name: skill.name }, context)
		expect((await read()).success).toBe(false)
		sources = [{ key: 'host:source', revision: 'v1' }]
		expect((await read()).success).toBe(true)
		expect(rendered(bundle, 'turn')).toContain(skill.body)
		sources = [{ key: 'host:source', revision: 'v2' }]
		expect(rendered(bundle, 'turn')).not.toContain(skill.body)
		expect(rendered(bundle, 'turn')).toContain('changed-source')
		expect((await read()).success).toBe(false)
		sources = []
		expect(rendered(bundle, 'turn')).toContain('unverified-source')
		expect(rendered(bundle, 'static') + rendered(bundle, 'dynamic')).not.toContain(skill.body)
	})
	it('does not allow a malformed resolver to replay earlier guidance', async () => {
		let broken = false
		const bundle = createResidentStepContext({
			...options(),
			resolveLearningSources: () => (broken ? [{ key: '', revision: '' }] : []),
		})
		await bundle.tools[0]!.execute({ name: 'checked-identifiers' }, context)
		broken = true
		expect((await bundle.tools[0]!.execute({ name: 'checked-identifiers' }, context)).success).toBe(
			false,
		)
		expect(rendered(bundle, 'turn')).toContain('unavailable')
		expect(rendered(bundle, 'turn')).not.toContain(learning().skills[0]!.body)
	})
	it('bounds advertised metadata and never partially injects a selected instruction', async () => {
		const input = options()
		const base = input.learning.skills[0]!
		input.learning = {
			...input.learning,
			preferences: Array.from({ length: 16 }, (_, i) => ({
				key: `preference-${i}`,
				value: 'p'.repeat(1000),
				evidence: base.evidence,
			})),
			skills: Array.from({ length: 16 }, (_, i) => {
				const candidate = {
					...base,
					name: `skill-${i}`,
					description: '"\\\n😀'.repeat(100),
					body: `INSTRUCTION_START${'b'.repeat(3900)}`,
				}
				const hash = hashResidentSkill(candidate)
				return { ...candidate, hash, verification: { ...base.verification, candidateHash: hash } }
			}),
		}
		const bundle = createResidentStepContext(input)
		const catalog = bundle.contributions
			.find((c) => c.id === 'namzu.resident-step.learning-catalogue')!
			.render({})!
		expect(catalog.length).toBeLessThan(9000)
		expect(catalog).toContain('descriptionShortened')
		expect(catalog).not.toContain('INSTRUCTION_START')
		const read = await bundle.tools[0]!.execute({ name: 'skill-0' }, context)
		expect(read.success).toBe(true)
		expect(read.output).toContain(input.learning.skills[0]!.body)
		const current = rendered(bundle, 'turn')
		expect(current).not.toContain('INSTRUCTION_START')
		expect(current).toContain('withheld or omitted')
	})
	it('honors cancellation before disclosure and creates no tool without skills', async () => {
		const bundle = createResidentStepContext(options())
		await expect(
			bundle.tools[0]!.execute(
				{ name: 'checked-identifiers' },
				{ ...context, abortSignal: AbortSignal.abort() },
			),
		).resolves.toMatchObject({ success: false, output: '' })
		expect(rendered(bundle, 'turn')).toBe('')
		expect(createResidentStepContext({ ...options(), learning: undefined }).tools).toEqual([])
	})
})

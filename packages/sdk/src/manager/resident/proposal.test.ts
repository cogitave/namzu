import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { ResidentAgendaState, ResidentPursuit } from './agenda.js'
import {
	type ResidentProposal,
	type ResidentProposalLimits,
	type ResidentProposalOrigin,
	validateResidentProposal,
} from './proposal.js'

const limits: ResidentProposalLimits = {
	domains: ['local-research'],
	maxChildrenPerParent: 2,
	maxDepth: 2,
}

function fixture() {
	const tenantId = randomUUID()
	const parentId = randomUUID()
	const parent: ResidentPursuit = {
		id: parentId,
		state: {
			tenantId,
			agentKey: 'proposal-test',
			pursuitId: parentId,
			identity: 'Local researcher',
			objective: 'Inspect the local fixture.',
			revision: 3,
			stepsAdmitted: 1,
			phase: 'waiting',
			wakeAt: null,
			reason: 'Waiting for local evidence.',
			summary: 'One check remains.',
			claimId: null,
		},
	}
	const agenda: ResidentAgendaState = {
		tenantId,
		agentKey: parent.state.agentKey,
		identity: parent.state.identity,
		revision: 5,
		paused: false,
		pursuits: [parent],
	}
	const proposal: ResidentProposal = {
		id: randomUUID(),
		parentId,
		parentRevision: parent.state.revision,
		domain: 'local-research',
		objective: 'Check the remaining fixture.',
		reason: 'A prior observation left an unanswered question.',
		evidenceKey: 'fixture:revision-1',
	}
	return { agenda, parent, proposal }
}

function child(parent: ResidentPursuit, origin: ResidentProposalOrigin): ResidentPursuit {
	const id = randomUUID()
	return {
		id,
		state: { ...parent.state, pursuitId: id, phase: 'complete' },
		origin,
	}
}

it('returns frozen provenance without mutating the proposal or admitting a pursuit', () => {
	const { agenda, proposal } = fixture()
	const before = structuredClone({ agenda, proposal })
	const origin = validateResidentProposal(agenda, proposal, limits)
	expect(origin).toEqual({
		proposalId: proposal.id,
		parentId: proposal.parentId,
		parentRevision: proposal.parentRevision,
		domain: proposal.domain,
		reason: proposal.reason,
		evidenceKey: proposal.evidenceKey,
		depth: 1,
	})
	expect(Object.isFrozen(origin)).toBe(true)
	expect({ agenda, proposal }).toEqual(before)
})

it('rejects paused agendas, unknown parents and stale parent revisions', () => {
	const { agenda, proposal } = fixture()
	expect(() => validateResidentProposal({ ...agenda, paused: true }, proposal, limits)).toThrow(
		'paused',
	)
	expect(() =>
		validateResidentProposal(agenda, { ...proposal, parentId: randomUUID() }, limits),
	).toThrow('Unknown')
	expect(() =>
		validateResidentProposal(agenda, { ...proposal, parentRevision: 2 }, limits),
	).toThrow('stale')
})

it('accepts completed parents but refuses unresolved and blocked parents', () => {
	const { agenda, parent, proposal } = fixture()
	for (const phase of ['running', 'blocked', 'complete'] as const) {
		const changed: ResidentAgendaState = {
			...agenda,
			pursuits: [
				{
					...parent,
					state: { ...parent.state, phase, claimId: phase === 'running' ? randomUUID() : null },
				},
			],
		}
		const check = () => validateResidentProposal(changed, proposal, limits)
		if (phase === 'complete') expect(check()).toMatchObject({ depth: 1 })
		else expect(check).toThrow('waiting or complete')
	}
})

it('requires an exact host-approved domain', () => {
	const { agenda, proposal } = fixture()
	for (const domain of ['external-research', ' local-research', 'LOCAL-RESEARCH']) {
		expect(() => validateResidentProposal(agenda, { ...proposal, domain }, limits)).toThrow(
			'host-approved',
		)
	}
})

it('rejects repeated proposal IDs even when the previously admitted child is complete', () => {
	const { agenda, parent, proposal } = fixture()
	const origin = validateResidentProposal(agenda, proposal, limits)
	const admitted = { ...agenda, pursuits: [...agenda.pursuits, child(parent, origin)] }
	expect(() => validateResidentProposal(admitted, proposal, limits)).toThrow(
		'already been admitted',
	)
})

it('counts terminal children toward per-parent and whole-agenda bounds', () => {
	const { agenda, parent, proposal } = fixture()
	const origin = validateResidentProposal(agenda, proposal, limits)
	const children = Array.from({ length: 31 }, () =>
		child(parent, { ...origin, proposalId: randomUUID() }),
	)
	expect(() =>
		validateResidentProposal(
			{ ...agenda, pursuits: [...agenda.pursuits, ...children.slice(0, 2)] },
			proposal,
			limits,
		),
	).toThrow('child bound')
	expect(() =>
		validateResidentProposal(
			{ ...agenda, pursuits: [...agenda.pursuits, ...children] },
			proposal,
			limits,
		),
	).toThrow('pursuit bound')
})

it('derives subgoal depth from its admitted parent and enforces the host cap', () => {
	const { agenda, parent, proposal } = fixture()
	const origin = validateResidentProposal(agenda, proposal, limits)
	const firstChild = child(parent, origin)
	const nested = { ...agenda, pursuits: [...agenda.pursuits, firstChild] }
	const descendant = {
		...proposal,
		id: randomUUID(),
		parentId: firstChild.id,
		parentRevision: firstChild.state.revision,
	}
	expect(validateResidentProposal(nested, descendant, limits)).toMatchObject({ depth: 2 })
	expect(() => validateResidentProposal(nested, descendant, { ...limits, maxDepth: 1 })).toThrow(
		'depth bound',
	)
})

it('rejects invalid proposal fields and admission limits before returning provenance', () => {
	const { agenda, proposal } = fixture()
	for (const change of [
		{ id: 'invalid' },
		{ parentId: 'invalid' },
		{ parentRevision: 0 },
		{ parentRevision: 1.5 },
		{ domain: ' ' },
		{ domain: 'a'.repeat(121) },
		{ objective: '' },
		{ objective: 'a'.repeat(8_001) },
		{ reason: ' ' },
		{ reason: 'a'.repeat(1_001) },
		{ evidenceKey: '' },
		{ evidenceKey: 'a'.repeat(257) },
	]) {
		expect(() => validateResidentProposal(agenda, { ...proposal, ...change }, limits)).toThrow()
	}
	for (const change of [
		{ domains: [] },
		{ maxChildrenPerParent: 0 },
		{ maxChildrenPerParent: 9 },
		{ maxChildrenPerParent: 1.5 },
		{ maxDepth: 0 },
		{ maxDepth: 5 },
	]) {
		expect(() => validateResidentProposal(agenda, proposal, { ...limits, ...change })).toThrow()
	}
})

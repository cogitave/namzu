import { z } from 'zod'
import type { ResidentAgendaState } from './agenda.js'

const identifier = z.string().uuid()
const revision = z.number().int().positive().safe()
const domain = z
	.string()
	.min(1)
	.max(120)
	.refine((value) => value.trim().length > 0, 'A proposal domain must contain text.')
const reason = z.string().trim().min(1).max(1_000)
const evidenceKey = z.string().trim().min(1).max(256)

const proposalSchema = z.object({
	id: identifier,
	parentId: identifier,
	parentRevision: revision,
	domain,
	objective: z.string().trim().min(1).max(8_000),
	reason,
	evidenceKey,
})

const limitsSchema = z.object({
	domains: z.array(domain).min(1),
	maxChildrenPerParent: z.number().int().min(1).max(8),
	maxDepth: z.number().int().min(1).max(4),
})

/** @experimental An inert subgoal proposal; creating it grants no execution authority. */
export interface ResidentProposal {
	readonly id: string
	readonly parentId: string
	readonly parentRevision: number
	readonly domain: string
	readonly objective: string
	readonly reason: string
	readonly evidenceKey: string
}

/** @experimental Host-approved routing domains and finite subgoal admission bounds. */
export interface ResidentProposalLimits {
	readonly domains: readonly string[]
	readonly maxChildrenPerParent: number
	readonly maxDepth: number
}

/** Persisted provenance shared with the agenda's schema validation. */
export const residentProposalOriginSchema = z.object({
	proposalId: identifier,
	parentId: identifier,
	parentRevision: revision,
	domain,
	reason,
	evidenceKey,
	depth: z.number().int().min(1).max(4),
})

/** @experimental Host-admitted ancestry and evidence for a resident subgoal. */
export type ResidentProposalOrigin = Readonly<z.infer<typeof residentProposalOriginSchema>>

/**
 * @experimental Pure validation against one agenda snapshot. The host must
 * atomically bind this snapshot to admission. Domains are routing metadata;
 * this does not prove an objective fits its domain or authorize any tools.
 */
export function validateResidentProposal(
	agenda: ResidentAgendaState,
	input: ResidentProposal,
	limits: ResidentProposalLimits,
): ResidentProposalOrigin {
	const proposal = proposalSchema.parse(input)
	const policy = limitsSchema.parse(limits)
	if (agenda.paused) throw new Error('A paused agenda cannot admit resident proposals.')
	if (agenda.pursuits.length >= 32) throw new Error('Resident agenda pursuit bound reached.')
	if (agenda.pursuits.some((pursuit) => pursuit.origin?.proposalId === proposal.id))
		throw new Error('Resident proposal has already been admitted.')
	const parent = agenda.pursuits.find((pursuit) => pursuit.id === proposal.parentId)
	if (!parent) throw new Error('Unknown resident proposal parent.')
	if (parent.state.revision !== proposal.parentRevision)
		throw new Error('Resident proposal parent revision is stale.')
	if (parent.state.phase !== 'waiting' && parent.state.phase !== 'complete')
		throw new Error('Resident proposal parent must be waiting or complete.')
	if (!policy.domains.includes(proposal.domain))
		throw new Error('Resident proposal domain is not host-approved.')
	if (
		agenda.pursuits.filter((pursuit) => pursuit.origin?.parentId === parent.id).length >=
		policy.maxChildrenPerParent
	)
		throw new Error('Resident proposal parent child bound reached.')
	const depth = (parent.origin?.depth ?? 0) + 1
	if (depth > policy.maxDepth) throw new Error('Resident proposal depth bound reached.')
	return Object.freeze(
		residentProposalOriginSchema.parse({
			proposalId: proposal.id,
			parentId: proposal.parentId,
			parentRevision: proposal.parentRevision,
			domain: proposal.domain,
			reason: proposal.reason,
			evidenceKey: proposal.evidenceKey,
			depth,
		}),
	)
}

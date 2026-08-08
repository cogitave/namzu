/**
 * Do the members of a provider chain agree about what they can do?
 *
 * The runtime negotiates capabilities ONCE per run, against the provider it was
 * handed, and that answer decides whether tool surfaces go into the prompt and
 * whether image and document attachments are mapped. A chain whose members
 * disagree therefore cannot be honoured by taking the strongest answer: if the
 * run falls over to a weaker member it arrives holding a request shaped for a
 * provider that is no longer serving it — tools advertised that cannot be
 * called, images the driver will not map.
 *
 * The alternative to refusing is intersecting: quietly take the floor of the
 * chain. That is worse, and worse in the direction that matters. An operator who
 * adds a weaker fallback to gain resilience would find their PRIMARY had quietly
 * lost tool support, permanently, with nothing saying so — a capability given up
 * on every run to guard against a failure that happens rarely. So a disagreement
 * is refused and named, and an operator who wants the intersection anyway says
 * so explicitly.
 *
 * ## This compares DECLARATIONS, and says only that
 *
 * What is compared is what each driver declares at the type level, which is the
 * only thing knowable before a provider is constructed — and constructing one
 * would need a credential, which is exactly what a not-yet-configured fallback
 * does not have. The runtime treats the constructed INSTANCE's own declaration
 * as authoritative, so an instance can in principle disagree with its type.
 * Every sentence here therefore says "declares" rather than asserting what a
 * provider IS. A check that overstates its authority is how someone later finds
 * the runtime disagreed with it and stops believing it.
 *
 * ## And it is a property of the CHAIN, not of a run
 *
 * Only the primary runs today; nothing falls over yet. So no sentence here
 * claims a run is degraded — each says what becomes unavailable IF the chain
 * falls over. When failover lands the run-level statement becomes true and can
 * be made then. Making it now would be a confident claim about a degradation
 * that has not happened, which is the failure this line of work exists to
 * remove.
 */

import type { ResolvedProviderCapabilities } from '@namzu/sdk'

import { type ProviderChoice, chainPositionName } from './preferences.js'
import { PROVIDER_REGISTRY } from './registry.js'

/** A member paired with what it declares, or with why that could not be read. */
export type MemberCapabilities =
	| { readonly kind: 'known'; readonly capabilities: ResolvedProviderCapabilities }
	| { readonly kind: 'unresolved'; readonly reason: string }

export interface CapabilityDisagreement {
	/** Index of the member that declares the capability. */
	readonly declaredBy: number
	/** Index of the member that declares it does not have it. */
	readonly missingFrom: number
	/** One sentence naming both members and what is lost. */
	readonly sentence: string
}

/**
 * The boolean capabilities, with the words for having one, lacking it, and
 * losing it.
 *
 * `supportsStreaming` is here even though every shipped driver declares it. The
 * field exists and a third-party driver may not have it; leaving it out would
 * let a chain disagree on it and pass.
 */
const BOOLEAN_CAPABILITIES: ReadonlyArray<{
	readonly key:
		| 'supportsTools'
		| 'supportsFunctionCalling'
		| 'supportsStreaming'
		| 'supportsVision'
		| 'supportsDocuments'
	readonly has: string
	readonly lacks: string
	readonly consequence: string
}> = [
	{
		key: 'supportsTools',
		has: 'it can call tools',
		lacks: 'it cannot call tools',
		consequence: 'tools become unavailable',
	},
	{
		key: 'supportsFunctionCalling',
		has: 'it supports function calling',
		lacks: 'it does not support function calling',
		consequence: 'function calling becomes unavailable',
	},
	{
		key: 'supportsStreaming',
		has: 'it can stream replies',
		lacks: 'it cannot stream replies',
		consequence: 'replies stop streaming',
	},
	{
		key: 'supportsVision',
		has: 'it can read image attachments',
		lacks: 'it cannot read image attachments',
		consequence: 'image attachments stop being sent',
	},
	{
		key: 'supportsDocuments',
		has: 'it can read document attachments',
		lacks: 'it cannot read document attachments',
		consequence: 'document attachments stop being sent',
	},
]

function describe(index: number, member: ProviderChoice): string {
	const entry = PROVIDER_REGISTRY[member.id]
	return `${chainPositionName(index)} (${entry ? entry.label : member.id})`
}

/**
 * Every way the members of this chain declare different abilities.
 *
 * A disagreement is reported against the FIRST member that declares the
 * capability, because that is the behaviour the operator already has and would
 * be surprised to lose. Members whose capabilities could not be read contribute
 * nothing: an unestablished answer is not agreement, and counting it as one
 * would turn "I could not check this" into "this is fine".
 */
export function chainCapabilityDisagreements(
	members: readonly ProviderChoice[],
	resolved: readonly MemberCapabilities[],
): readonly CapabilityDisagreement[] {
	const out: CapabilityDisagreement[] = []

	for (const capability of BOOLEAN_CAPABILITIES) {
		const firstWithIt = resolved.findIndex(
			(entry) => entry.kind === 'known' && entry.capabilities[capability.key] === true,
		)
		if (firstWithIt === -1) continue
		const has = members[firstWithIt]
		if (!has) continue

		for (const [index, entry] of resolved.entries()) {
			if (entry.kind !== 'known' || index === firstWithIt) continue
			if (entry.capabilities[capability.key] === true) continue
			const lacks = members[index]
			if (!lacks) continue
			out.push({
				declaredBy: firstWithIt,
				missingFrom: index,
				sentence:
					`${describe(index, lacks)} declares ${capability.lacks}, while ` +
					`${describe(firstWithIt, has)} declares ${capability.has} — ` +
					`if the chain falls over to it, ${capability.consequence}.`,
			})
		}
	}

	out.push(...ceilingDisagreements(members, resolved))
	return out
}

/**
 * A smaller output ceiling is the same problem wearing a number: a run served by
 * that member produces shorter replies than the chain was configured for.
 * Reported against the LARGEST declared ceiling, for the reason the booleans are
 * reported against the first member that has the capability.
 */
function ceilingDisagreements(
	members: readonly ProviderChoice[],
	resolved: readonly MemberCapabilities[],
): readonly CapabilityDisagreement[] {
	const ceilings: { index: number; value: number }[] = []
	for (const [index, entry] of resolved.entries()) {
		if (entry.kind !== 'known') continue
		const value = entry.capabilities.maxOutputTokens
		if (typeof value === 'number') ceilings.push({ index, value })
	}
	// No `length < 2` guard: a lone ceiling is already handled below, because it
	// IS the largest and the comparison skips it. Adding one would be a branch
	// that cannot change the answer, which is a check that cannot fail
	// (`docs/conventions/a-check-that-cannot-fail.md`) — and a mutation proving
	// exactly that is how this one was found.
	let largest: { index: number; value: number } | undefined
	for (const ceiling of ceilings) {
		if (!largest || ceiling.value > largest.value) largest = ceiling
	}
	if (!largest) return []

	const out: CapabilityDisagreement[] = []
	for (const ceiling of ceilings) {
		if (ceiling.value >= largest.value) continue
		const has = members[largest.index]
		const lacks = members[ceiling.index]
		if (!has || !lacks) continue
		out.push({
			declaredBy: largest.index,
			missingFrom: ceiling.index,
			sentence:
				`${describe(ceiling.index, lacks)} declares a maximum output of ${ceiling.value} tokens, ` +
				`below ${describe(largest.index, has)} at ${largest.value} — ` +
				`if the chain falls over to it, replies are capped at ${ceiling.value}.`,
		})
	}
	return out
}

/** Members whose declarations could not be established, with the reason. */
export function unresolvedMembers(
	members: readonly ProviderChoice[],
	resolved: readonly MemberCapabilities[],
): readonly string[] {
	const out: string[] = []
	for (const [index, entry] of resolved.entries()) {
		const member = members[index]
		if (entry.kind !== 'unresolved' || !member) continue
		out.push(`${describe(index, member)}: ${entry.reason}`)
	}
	return out
}

/**
 * The refusal an operator reads, or null when the chain agrees.
 *
 * Every disagreement is named, not just the first: an operator who fixes the one
 * sentence they were shown and is refused again for the next has been made to
 * discover their own configuration one round-trip at a time.
 */
export function describeCapabilityRefusal(
	disagreements: readonly CapabilityDisagreement[],
): string | null {
	if (disagreements.length === 0) return null
	return [
		'The providers in your chain declare different capabilities, so namzu cannot honour the chain as written:',
		...disagreements.map((d) => `  - ${d.sentence}`),
		'',
		'Taking the strongest answer would advertise abilities a fallback does not have. Taking the weakest would cost your primary a capability on every run, to guard against a failure that happens rarely. Neither is chosen for you.',
		'Either drop the member that disagrees, or set "allowCapabilityMismatch": true in ~/.namzu/preferences.json to accept the limitation — it is printed on every launch.',
	].join('\n')
}

/** The same disagreements, worded for an operator who has already accepted them. */
export function describeAcceptedMismatch(
	disagreements: readonly CapabilityDisagreement[],
): string | null {
	if (disagreements.length === 0) return null
	return [
		'Provider chain: the members declare different capabilities, and you have accepted that.',
		...disagreements.map((d) => `  - ${d.sentence}`),
	].join('\n')
}

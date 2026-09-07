/**
 * Research executable, not a public SDK API or a neural simulation.
 * The host supplies task criteria and observation provenance. Natural-language
 * interpretation, action generation and calibrated belief learning are absent.
 */
import { updateReliability } from './association.mjs'

const MAX_EVENTS = 1024
const SNAPSHOT_BYTES = 4 * 1024 * 1024

function label(value, name, max = 1000) {
	if (typeof value !== 'string' || !value.trim() || value.length > max)
		throw new Error(`${name} must be nonempty text of at most ${max} characters`)
	return value
}

function integer(value, name, max = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || value < 1 || value > max)
		throw new Error(`${name} must be an integer in 1..${max}`)
	return value
}

function scalar(value) {
	if (value === null || typeof value === 'boolean') return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'string' && value.length <= 1000) return value
	throw new Error('Evidence values must be bounded finite JSON scalars')
}

function criteria(input) {
	if (!Array.isArray(input) || !input.length || input.length > 32)
		throw new Error('Supply 1..32 explicit criteria')
	const items = input.map((item) => ({
		key: label(item?.key, 'criterion key', 128),
		value: scalar(item.value),
	}))
	if (new Set(items.map((item) => item.key)).size !== items.length)
		throw new Error('Criterion keys must be unique')
	return items
}

function goal(input) {
	if (!Array.isArray(input?.constraints) || input.constraints.length > 32)
		throw new Error('Goal constraints must be an explicit bounded list')
	return {
		id: label(input.id, 'goal id', 128),
		description: label(input.description, 'goal description'),
		constraints: input.constraints.map((item) => label(item, 'constraint')),
		criteria: criteria(input.criteria),
	}
}

function evaluate(expected, observations) {
	return expected.map((criterion) => {
		const records = observations.filter(
			(item) => item.key === criterion.key && item.origin !== 'model',
		)
		const values = new Set(records.map((item) => JSON.stringify(item.value)))
		const status =
			values.size > 1
				? 'conflicted'
				: values.size === 0
					? 'unknown'
					: values.has(JSON.stringify(criterion.value))
						? 'verified'
						: 'contradicted'
		return { ...criterion, status, evidence: records.map((item) => item.id).sort() }
	})
}

/** Replayable, sequential control state. Its event journal never evicts obligations silently. */
export class ExecutiveWorkspace {
	#scope
	#initialGoal
	#goal
	#goalRevision = 1
	#environmentRevision = 1
	#events = []
	#records = new Map()
	#attempts = new Map()
	#plan
	#unchanged = 0
	#estimates = new Map()
	#strategyKinds = new Map()
	#maxEvents
	#stallLimit

	constructor({ scope, goal: initialGoal, maxEvents = 256, stallLimit = 2 }) {
		this.#scope = label(scope, 'scope', 128)
		this.#goal = goal(initialGoal)
		this.#initialGoal = structuredClone(this.#goal)
		this.#maxEvents = integer(maxEvents, 'maxEvents', MAX_EVENTS)
		this.#stallLimit = integer(stallLimit, 'stallLimit', 32)
	}

	#commit(event, change) {
		if (this.#events.length >= this.#maxEvents) throw new Error('Executive event budget exhausted')
		const projected = {
			version: 1,
			scope: this.#scope,
			goal: this.#initialGoal,
			maxEvents: this.#maxEvents,
			stallLimit: this.#stallLimit,
			events: [...this.#events, event],
		}
		if (Buffer.byteLength(JSON.stringify(projected)) > SNAPSHOT_BYTES)
			throw new Error('Snapshot byte budget exceeded before state update')
		this.#events.push(structuredClone(event))
		change()
	}

	#current() {
		return [...this.#records.values()].filter((item) => item.revision === this.#environmentRevision)
	}

	#fingerprint() {
		// Semantic progress belongs to host criteria, not changing log IDs or timestamps.
		return JSON.stringify(
			evaluate(this.#goal.criteria, this.#current()).map(({ key, status }) => [key, status]),
		)
	}

	reviseGoal(input) {
		const next = goal(input)
		this.#commit({ kind: 'goal', value: next }, () => {
			this.#goal = next
			this.#goalRevision += 1
			this.#plan = undefined
			this.#unchanged = 0
			this.#estimates.clear()
			this.#strategyKinds.clear()
		})
	}

	reviseEnvironment(revision) {
		integer(revision, 'environment revision')
		if (revision <= this.#environmentRevision)
			throw new Error('Environment revisions must increase')
		this.#commit({ kind: 'environment', revision }, () => {
			this.#environmentRevision = revision
		})
	}

	setPlan(strategy) {
		label(strategy, 'strategy', 128)
		this.#commit({ kind: 'plan', strategy }, () => {
			if (strategy !== this.#plan) this.#unchanged = 0
			this.#plan = strategy
		})
	}

	observe(input) {
		const observation = {
			id: label(input?.id, 'observation id', 128),
			scope: label(input.scope, 'observation scope', 128),
			revision: integer(input.revision, 'observation revision'),
			key: label(input.key, 'observation key', 128),
			value: scalar(input.value),
			origin: input.origin,
			source: label(input.source, 'source', 128),
			...(input.actionId === undefined
				? {}
				: { actionId: label(input.actionId, 'action id', 128) }),
		}
		if (observation.scope !== this.#scope) throw new Error('Observation belongs to another scope')
		if (!['tool', 'operator', 'model'].includes(observation.origin))
			throw new Error('Unknown observation origin')
		if (observation.revision > this.#environmentRevision)
			throw new Error('Observation from a future revision')
		const previous = this.#records.get(observation.id)
		if (previous) {
			if (JSON.stringify(previous) !== JSON.stringify(observation))
				throw new Error('Evidence IDs are immutable')
			return false
		}
		if (observation.actionId !== undefined) {
			const attempt = this.#attempts.get(observation.actionId)
			if (
				!attempt ||
				attempt.status !== 'pending' ||
				observation.revision < attempt.startedRevision
			)
				throw new Error('Action evidence must be observed during its pending attempt')
		}
		this.#commit({ kind: 'observation', value: observation }, () =>
			this.#records.set(observation.id, observation),
		)
		return true
	}

	begin({ actionId, expected, requiresProgress = true, mayChangeState = true }) {
		label(actionId, 'action id', 128)
		if (!this.#plan) throw new Error('Select an explicit plan before acting')
		if (this.#attempts.has(actionId)) throw new Error('Action ID already used')
		if ([...this.#attempts.values()].some((attempt) => attempt.status === 'pending'))
			throw new Error('Settle the pending action before beginning another')
		if (typeof requiresProgress !== 'boolean') throw new Error('requiresProgress must be boolean')
		if (typeof mayChangeState !== 'boolean') throw new Error('mayChangeState must be boolean')
		const kind = mayChangeState ? 'intervention' : 'observation'
		const existingKind = this.#strategyKinds.get(this.#plan)
		if (existingKind !== undefined && existingKind !== kind)
			throw new Error('Strategy role changed')
		const prediction = criteria(expected)
		const before = this.#fingerprint()
		if (mayChangeState) integer(this.#environmentRevision + 1, 'environment revision')
		this.#commit(
			{ kind: 'begin', actionId, expected: prediction, requiresProgress, mayChangeState },
			() => {
				// Invalidate before dispatch: a timeout/cancellation can hide a real write.
				if (mayChangeState) this.#environmentRevision += 1
				this.#strategyKinds.set(this.#plan, kind)
				this.#attempts.set(actionId, {
					actionId,
					strategy: this.#plan,
					expected: prediction,
					requiresProgress,
					mayChangeState,
					goalRevision: this.#goalRevision,
					startedRevision: this.#environmentRevision,
					before,
					status: 'pending',
				})
			},
		)
	}

	settle({ actionId, evidenceIds, transportSuccess }) {
		const attempt = this.#attempts.get(actionId)
		if (!attempt || attempt.status !== 'pending') throw new Error('Action is not pending')
		if (
			!Array.isArray(evidenceIds) ||
			evidenceIds.length > 64 ||
			new Set(evidenceIds).size !== evidenceIds.length
		)
			throw new Error('Supply at most 64 unique evidence IDs')
		if (typeof transportSuccess !== 'boolean') throw new Error('Transport success must be explicit')
		for (const id of evidenceIds) if (!this.#records.has(id)) throw new Error('Unknown evidence ID')
		// A caller cannot improve a verdict by omitting a known contradictory receipt.
		const observations = this.#current().filter(
			(item) => item.actionId === actionId && item.origin === 'tool',
		)
		const statuses = evaluate(attempt.expected, observations)
		const status =
			attempt.goalRevision !== this.#goalRevision
				? 'unknown'
				: statuses.some((item) => item.status === 'conflicted')
					? 'conflicted'
					: statuses.some((item) => item.status === 'contradicted')
						? 'contradicted'
						: statuses.every((item) => item.status === 'verified')
							? 'verified'
							: 'unknown'
		const before = new Map(JSON.parse(attempt.before))
		const evidenceChanged = evaluate(this.#goal.criteria, observations).some(
			(item) => item.status !== 'unknown' && item.status !== before.get(item.key),
		)
		this.#commit({ kind: 'settle', actionId, evidenceIds, transportSuccess }, () => {
			attempt.status = status
			attempt.transportSuccess = transportSuccess
			attempt.evidenceIds = observations.map((item) => item.id)
			attempt.evidenceChanged = evidenceChanged
			if (attempt.goalRevision !== this.#goalRevision) return
			if (attempt.requiresProgress) this.#unchanged = evidenceChanged ? 0 : this.#unchanged + 1
			const outcome =
				status === 'verified' ? 'success' : status === 'contradicted' ? 'failure' : 'unknown'
			const estimate = this.#estimates.get(attempt.strategy) ?? 0.5
			this.#estimates.set(
				attempt.strategy,
				updateReliability(estimate, { kind: 'outcome', outcome, attributedTo: actionId }, 0.2),
			)
		})
		return { status, evidenceChanged, transportSuccess }
	}

	recommendStrategy(candidates) {
		if (!Array.isArray(candidates) || !candidates.length || candidates.length > 32)
			throw new Error('Supply 1..32 host-admitted strategies')
		const interventions = [
			...new Set(candidates.map((item) => label(item, 'strategy', 128))),
		].filter((item) => this.#strategyKinds.get(item) !== 'observation')
		if (!interventions.length) throw new Error('No intervention strategy among admitted candidates')
		return interventions.sort(
			(a, b) =>
				(this.#estimates.get(b) ?? 0.5) - (this.#estimates.get(a) ?? 0.5) ||
				(a < b ? -1 : a > b ? 1 : 0),
		)[0]
	}

	inspect() {
		const checks = evaluate(this.#goal.criteria, this.#current())
		const pending = [...this.#attempts.values()]
			.filter((attempt) => attempt.status === 'pending')
			.map((attempt) => attempt.actionId)
		// A settled goal still has to wait for owned in-flight effects to become known.
		const mode = pending.length
			? 'observe'
			: checks.some((item) => item.status === 'conflicted')
				? 'verify'
				: checks.every((item) => item.status === 'verified')
					? 'complete'
					: this.#unchanged >= this.#stallLimit
						? 'replan'
						: !this.#plan
							? 'plan'
							: checks.some((item) => item.status === 'unknown')
								? 'observe'
								: 'act'
		return structuredClone({
			scope: this.#scope,
			goal: this.#goal,
			goalRevision: this.#goalRevision,
			environmentRevision: this.#environmentRevision,
			plan: this.#plan,
			mode,
			checks,
			pending,
			unchangedAttempts: this.#unchanged,
			estimates: Object.fromEntries(this.#estimates),
			strategyKinds: Object.fromEntries(this.#strategyKinds),
		})
	}

	canConclude() {
		return this.inspect().mode === 'complete'
	}

	snapshot() {
		const value = {
			version: 1,
			scope: this.#scope,
			goal: this.#initialGoal,
			maxEvents: this.#maxEvents,
			stallLimit: this.#stallLimit,
			events: this.#events,
		}
		if (Buffer.byteLength(JSON.stringify(value)) > SNAPSHOT_BYTES)
			throw new Error('Snapshot byte budget exceeded')
		return structuredClone(value)
	}

	static restore(value, expectedScope) {
		if (Buffer.byteLength(JSON.stringify(value)) > SNAPSHOT_BYTES)
			throw new Error('Snapshot byte budget exceeded')
		if (value?.version !== 1 || value.scope !== expectedScope)
			throw new Error('Snapshot version or scope mismatch')
		if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS)
			throw new Error('Invalid event journal')
		const workspace = new ExecutiveWorkspace(value)
		for (const event of value.events) {
			switch (event?.kind) {
				case 'goal':
					workspace.reviseGoal(event.value)
					break
				case 'environment':
					workspace.reviseEnvironment(event.revision)
					break
				case 'plan':
					workspace.setPlan(event.strategy)
					break
				case 'observation':
					workspace.observe(event.value)
					break
				case 'begin':
					workspace.begin(event)
					break
				case 'settle':
					workspace.settle(event)
					break
				default:
					throw new Error('Unknown executive event')
			}
		}
		return workspace
	}
}

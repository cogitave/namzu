// Research prototype: activation ranks evidence; it is not factual confidence.
// No model calls, embeddings, generated links, or persistent state.

const CEILINGS = Object.freeze({ maxNodes: 4096, maxEdges: 32768, iterations: 256 })

function record(value, name) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${name} must be an object`)
	}
}

function label(value, name) {
	if (typeof value !== 'string' || !value.trim() || value.length > 256) {
		throw new TypeError(`${name} must be a nonempty string of at most 256 characters`)
	}
}

function positive(value, name) {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} must be positive and finite`)
	}
}

function limit(value, name, minimum) {
	if (!Number.isSafeInteger(value) || value < minimum || value > CEILINGS[name]) {
		throw new RangeError(`${name} must be an integer in [${minimum}, ${CEILINGS[name]}]`)
	}
}

function boundedArray(value, name, maximum) {
	if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`)
	if (value.length > maximum) throw new RangeError(`${name} exceeds its input limit`)
}

function compareText(a, b) {
	return a < b ? -1 : a > b ? 1 : 0
}

// Scale before summation so even several Number.MAX_VALUE weights stay finite.
function normalize(weights) {
	let maximum = 0
	for (const weight of weights) maximum = Math.max(maximum, weight)
	let total = 0
	for (const weight of weights) total += weight / maximum
	return weights.map((weight) => weight / maximum / total)
}

/**
 * Bounded sparse restart diffusion: a' = (1 - alpha) q + alpha P^T a.
 *
 * Nodes: { id, scope }; directed edges: { scope, from, to, type, weight };
 * cues: { id, weight }. Edge types are explicit labels, never inferred.
 * All labels are bounded strings; weights must be positive finite numbers.
 * Duplicate node IDs within a scope and duplicate cue IDs are rejected.
 * Limits apply to raw input arrays, including foreign scopes, before scanning.
 * Edges outside the scope or with an endpoint outside it are excluded before
 * row normalization. A node without eligible outgoing edges has a self loop.
 *
 * Returns { ranking: [{ id, activation }], residual, steps }. Ranking includes
 * zero-activation nodes. Ties use ascending ID order. Residual is the L1 norm
 * ||T(a) - a|| of the returned vector. `iterations` bounds applied updates;
 * at most one additional transition evaluates the final residual. Reaching
 * the iteration cap does not imply convergence; callers must inspect residual.
 */
export function recallAssociations(options) {
	record(options, 'options')
	const {
		scope,
		nodes,
		edges,
		cues,
		alpha = 0.6,
		iterations = 64,
		tolerance = 1e-10,
		maxNodes = 512,
		maxEdges = 4096,
	} = options
	label(scope, 'scope')
	limit(maxNodes, 'maxNodes', 1)
	limit(maxEdges, 'maxEdges', 0)
	limit(iterations, 'iterations', 1)
	if (!Number.isFinite(alpha) || alpha < 0 || alpha >= 1) {
		throw new RangeError('alpha must be finite and in [0, 1)')
	}
	if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
		throw new RangeError('tolerance must be finite and in [0, 1]')
	}
	boundedArray(nodes, 'nodes', maxNodes)
	boundedArray(edges, 'edges', maxEdges)
	boundedArray(cues, 'cues', maxNodes)
	if (cues.length === 0) throw new RangeError('at least one cue is required')

	const identities = new Set()
	const ids = []
	for (const node of nodes) {
		record(node, 'node')
		label(node.id, 'node.id')
		label(node.scope, 'node.scope')
		const identity = JSON.stringify([node.scope, node.id])
		if (identities.has(identity)) throw new RangeError('duplicate node in a scope')
		identities.add(identity)
		if (node.scope === scope) ids.push(node.id)
	}
	ids.sort(compareText)
	if (ids.length === 0) throw new RangeError('scope must contain at least one node')
	const indices = new Map(ids.map((id, index) => [id, index]))
	const eligibleEdges = []
	for (const edge of edges) {
		record(edge, 'edge')
		for (const key of ['scope', 'from', 'to', 'type']) label(edge[key], `edge.${key}`)
		positive(edge.weight, 'edge.weight')
		if (edge.scope === scope && indices.has(edge.from) && indices.has(edge.to)) {
			eligibleEdges.push(edge)
		}
	}
	// Canonical summation order makes results independent of input permutations.
	eligibleEdges.sort(
		(a, b) =>
			compareText(a.from, b.from) ||
			compareText(a.to, b.to) ||
			compareText(a.type, b.type) ||
			a.weight - b.weight,
	)
	const rows = ids.map(() => [])
	for (const edge of eligibleEdges) {
		rows[indices.get(edge.from)].push({ to: indices.get(edge.to), weight: edge.weight })
	}
	for (const [index, row] of rows.entries()) {
		if (row.length === 0) row.push({ to: index, weight: 1 })
		const weights = normalize(row.map((edge) => edge.weight))
		for (let i = 0; i < row.length; i++) row[i].weight = weights[i]
	}

	const cueWeights = new Float64Array(ids.length)
	const seenCues = new Set()
	for (const cue of cues) {
		record(cue, 'cue')
		label(cue.id, 'cue.id')
		positive(cue.weight, 'cue.weight')
		if (!indices.has(cue.id)) throw new RangeError('cue must identify a node in the scope')
		if (seenCues.has(cue.id)) throw new RangeError('duplicate cue ID')
		seenCues.add(cue.id)
		cueWeights[indices.get(cue.id)] = cue.weight
	}
	const q = normalize(cueWeights)
	function advance(activation) {
		const next = q.map((weight) => (1 - alpha) * weight)
		for (let from = 0; from < rows.length; from++) {
			for (const edge of rows[from]) {
				next[edge.to] += alpha * activation[from] * edge.weight
			}
		}
		return next
	}
	function distance(a, b) {
		let result = 0
		for (let i = 0; i < a.length; i++) result += Math.abs(a[i] - b[i])
		return result
	}
	let activation = q
	let next = advance(activation)
	let residual = distance(next, activation)
	let steps = 0
	while (steps < iterations && residual > tolerance) {
		activation = next
		steps++
		next = advance(activation)
		residual = distance(next, activation)
	}
	const ranking = ids.map((id, index) => ({ id, activation: activation[index] }))
	ranking.sort((a, b) => b.activation - a.activation || compareText(a.id, b.id))
	return { ranking, residual, steps }
}

/**
 * EWMA of attributable observed outcomes, not factual confidence.
 * A retrieval or unknown outcome returns the estimate unchanged. A known
 * outcome needs an explicit attempt ID in `attributedTo`. The caller owns
 * outcome verification and deduplication; this stateless helper cannot prove
 * attribution or tell whether an event was previously applied.
 */
export function updateReliability(estimate, event, learningRate = 0.1) {
	if (!Number.isFinite(estimate) || estimate < 0 || estimate > 1) {
		throw new RangeError('estimate must be finite and in [0, 1]')
	}
	if (!Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1) {
		throw new RangeError('learningRate must be finite and in (0, 1]')
	}
	record(event, 'event')
	if (event.kind === 'retrieval') return estimate
	if (event.kind !== 'outcome') throw new TypeError('event.kind must be retrieval or outcome')
	if (event.outcome === 'unknown') return estimate
	if (event.outcome !== 'success' && event.outcome !== 'failure') {
		throw new TypeError('event.outcome must be success, failure, or unknown')
	}
	label(event.attributedTo, 'event.attributedTo')
	const observed = event.outcome === 'success' ? 1 : 0
	return estimate + learningRate * (observed - estimate)
}

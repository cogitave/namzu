import assert from 'node:assert/strict'
import test from 'node:test'
import { recallAssociations, updateReliability } from './association.mjs'

const scope = 'project-a'
const node = (id, nodeScope = scope) => ({ id, scope: nodeScope })
const edge = (from, to, weight = 1, edgeScope = scope) => ({
	scope: edgeScope,
	from,
	to,
	type: 'resolvedBy',
	weight,
})
const fixture = () => ({
	scope,
	nodes: [node('symptom'), node('episode'), node('solution'), node('unrelated')],
	edges: [edge('symptom', 'episode'), edge('episode', 'solution')],
	cues: [{ id: 'symptom', weight: 1 }],
})
const activations = (result) =>
	Object.fromEntries(result.ranking.map((row) => [row.id, row.activation]))
const near = (actual, expected, tolerance = 1e-12) =>
	assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`)

test('partial cues activate linked evidence and preserve probability mass', () => {
	const result = recallAssociations(fixture())
	const values = activations(result)
	near(values.symptom, 0.4)
	near(values.episode, 0.24)
	near(values.solution, 0.36)
	assert.equal(values.unrelated, 0)
	near(
		result.ranking.reduce((sum, row) => sum + row.activation, 0),
		1,
	)
	assert.ok(result.ranking.every((row) => row.activation >= 0 && Number.isFinite(row.activation)))
	assert.ok(result.residual <= 1e-10)
	assert.ok(result.steps <= 64)
	assert.equal('confidence' in result.ranking[0], false)
})

test('dangling nodes keep mass through self loops, including an entirely edgeless graph', () => {
	const result = recallAssociations({
		...fixture(),
		edges: [],
		cues: [
			{ id: 'solution', weight: 3 },
			{ id: 'symptom', weight: 1 },
		],
		maxEdges: 0,
	})
	assert.deepEqual(activations(result), { solution: 0.75, symptom: 0.25, episode: 0, unrelated: 0 })
	assert.equal(result.steps, 0)
	assert.equal(result.residual, 0)
})

test('residual belongs to the returned vector, and iteration caps expose nonconvergence', () => {
	const input = {
		scope,
		nodes: [node('a'), node('b')],
		edges: [edge('a', 'b'), edge('b', 'a')],
		cues: [{ id: 'a', weight: 1 }],
		alpha: 0.8,
	}
	const capped = recallAssociations({ ...input, iterations: 1 })
	const values = activations(capped)
	const actualResidual =
		Math.abs(0.2 + 0.8 * values.b - values.a) + Math.abs(0.8 * values.a - values.b)
	near(capped.residual, actualResidual)
	assert.equal(capped.steps, 1)
	assert.ok(capped.residual > 1)
	const converged = recallAssociations({ ...input, iterations: 256, tolerance: 1e-12 })
	near(activations(converged).a, 1 / 1.8)
	near(activations(converged).b, 0.8 / 1.8)
	assert.ok(converged.residual <= 1e-12)
})

test('foreign nodes and cross-scope edges cannot redirect or dilute active mass', () => {
	const original = fixture()
	const contaminated = {
		...original,
		nodes: [...original.nodes, node('foreign', 'project-b'), node('symptom', 'project-b')],
		edges: [
			...original.edges,
			edge('symptom', 'foreign', 1000),
			edge('foreign', 'unrelated', 1000),
			edge('symptom', 'unrelated', 1000, 'project-b'),
		],
	}
	assert.deepEqual(recallAssociations(contaminated), recallAssociations(original))
})

test('shuffled-link negative control loses the relevant solution despite identical graph size', () => {
	const correct = activations(recallAssociations(fixture()))
	const shuffled = activations(
		recallAssociations({
			...fixture(),
			edges: [edge('symptom', 'episode'), edge('episode', 'unrelated')],
		}),
	)
	assert.ok(correct.solution > 0.3)
	assert.equal(shuffled.solution, 0)
	near(shuffled.unrelated, correct.solution)
})

test('weighted transitions are normalized without overflow', () => {
	const result = recallAssociations({
		scope,
		nodes: [node('a'), node('b'), node('c')],
		edges: [edge('a', 'b', Number.MAX_VALUE), edge('a', 'c', Number.MAX_VALUE)],
		cues: [
			{ id: 'a', weight: Number.MAX_VALUE },
			{ id: 'b', weight: Number.MAX_VALUE },
		],
	})
	const values = activations(result)
	near(values.a, 0.2)
	near(values.b, 0.65)
	near(values.c, 0.15)
	near(
		Object.values(values).reduce((sum, value) => sum + value, 0),
		1,
	)
})

test('input permutations and exact activation ties have deterministic ordering', () => {
	const input = {
		scope,
		nodes: [node('z'), node('a'), node('cue')],
		edges: [edge('cue', 'z'), edge('cue', 'a'), edge('z', 'cue', 0.2)],
		cues: [
			{ id: 'cue', weight: 1 },
			{ id: 'a', weight: 0.5 },
		],
	}
	assert.deepEqual(
		recallAssociations(input),
		recallAssociations({
			...input,
			nodes: [...input.nodes].reverse(),
			edges: [...input.edges].reverse(),
			cues: [...input.cues].reverse(),
		}),
	)
	const tied = recallAssociations({ ...input, edges: [], cues: [{ id: 'cue', weight: 1 }] })
	assert.deepEqual(
		tied.ranking.map((row) => row.id),
		['cue', 'a', 'z'],
	)
})

test('zero propagation returns normalized cues without spreading', () => {
	const result = recallAssociations({ ...fixture(), alpha: 0 })
	assert.equal(activations(result).symptom, 1)
	assert.equal(activations(result).episode, 0)
	assert.equal(result.residual, 0)
	assert.equal(result.steps, 0)
})

test('invalid weights, scopes, duplicate identities, and oversized raw inputs are rejected', () => {
	for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
		assert.throws(() =>
			recallAssociations({ ...fixture(), edges: [edge('symptom', 'episode', weight)] }),
		)
		assert.throws(() => recallAssociations({ ...fixture(), cues: [{ id: 'symptom', weight }] }))
	}
	for (const changed of [
		{ scope: '' },
		{ nodes: null },
		{ edges: {} },
		{ cues: [] },
		{ cues: [{ id: 'absent', weight: 1 }] },
		{ nodes: [node('same'), node('same')] },
		{ nodes: [node('foreign', 'project-b')] },
		{
			cues: [
				{ id: 'symptom', weight: 1 },
				{ id: 'symptom', weight: 2 },
			],
		},
		{ edges: [{ ...edge('symptom', 'episode'), type: '' }] },
		{ maxNodes: 3 },
		{ maxEdges: 1 },
	])
		assert.throws(() => recallAssociations({ ...fixture(), ...changed }))
	assert.throws(
		() =>
			recallAssociations({
				...fixture(),
				nodes: [...fixture().nodes, node('foreign', 'project-b')],
				maxNodes: 4,
			}),
		/input limit/,
	)
})

test('unsafe numerical options and work limits are rejected before execution', () => {
	for (const changed of [
		{ alpha: 1 },
		{ alpha: -0.1 },
		{ alpha: Number.NaN },
		{ tolerance: Number.POSITIVE_INFINITY },
		{ tolerance: -1 },
		{ tolerance: 2 },
		{ iterations: 0 },
		{ iterations: 257 },
		{ iterations: 1.5 },
		{ maxNodes: 0 },
		{ maxNodes: 4097 },
		{ maxNodes: Number.POSITIVE_INFINITY },
		{ maxEdges: -1 },
		{ maxEdges: 32769 },
		{ maxEdges: 1.5 },
	])
		assert.throws(() => recallAssociations({ ...fixture(), ...changed }))
})

test('reliability changes only for known outcomes attributed to an attempt', () => {
	const result = (outcome) => ({ kind: 'outcome', outcome, attributedTo: 'attempt-1' })
	near(updateReliability(0.5, result('success'), 0.2), 0.6)
	near(updateReliability(0.5, result('failure'), 0.2), 0.4)
	assert.equal(updateReliability(0.5, { kind: 'outcome', outcome: 'unknown' }), 0.5)
	assert.equal(updateReliability(0.5, { kind: 'retrieval', outcome: 'success' }), 0.5)
	assert.throws(
		() => updateReliability(0.5, { kind: 'outcome', outcome: 'success' }),
		/attributedTo/,
	)
	let estimate = 0.5
	for (let i = 0; i < 1000; i++) {
		estimate = updateReliability(estimate, result(i % 3 ? 'success' : 'failure'), 0.3)
		assert.ok(estimate >= 0 && estimate <= 1)
	}
	assert.equal(updateReliability(0.5, result('success'), 1), 1)
	assert.equal(updateReliability(0.5, result('failure'), 1), 0)
})

test('reliability rejects invalid estimates, update rates, and outcome events', () => {
	for (const estimate of [-1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => updateReliability(estimate, { kind: 'retrieval' }))
	}
	for (const rate of [0, -1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => updateReliability(0.5, { kind: 'retrieval' }, rate))
	}
	for (const event of [null, {}, { kind: 'outcome', outcome: true }]) {
		assert.throws(() => updateReliability(0.5, event))
	}
})

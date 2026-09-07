/** Local-compute measurement of an explicitly bounded candidate graph. */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { cpus } from 'node:os'
import { recallAssociations } from './association.mjs'

const scope = 'local-measurement'
const nodes = Array.from({ length: 256 }, (_, i) => ({ id: `record-${i}`, scope }))
const edges = nodes.flatMap((node, i) =>
	[1, 3, 7, 19].map((offset) => ({
		scope,
		from: node.id,
		to: nodes[(i + offset) % nodes.length].id,
		type: 'related',
		weight: 1 / offset,
	})),
)
function run(i) {
	const result = recallAssociations({
		scope,
		nodes,
		edges,
		cues: [{ id: nodes[i % nodes.length].id, weight: 1 }],
		iterations: 64,
	})
	assert.ok(
		Math.abs(result.ranking.reduce((total, item) => total + item.activation, 0) - 1) < 1e-10,
	)
	return result
}
for (let i = 0; i < 5; i++) run(i)
const samples = []
const cpu = process.cpuUsage()
let maxResidual = 0
for (let i = 0; i < 100; i++) {
	const started = performance.now()
	maxResidual = Math.max(maxResidual, run(i).residual)
	samples.push(performance.now() - started)
}
samples.sort((a, b) => a - b)
const used = process.cpuUsage(cpu)
process.stdout.write(
	`${JSON.stringify(
		{
			kind: 'bounded-association-local-compute',
			node: process.version,
			platform: process.platform,
			architecture: process.arch,
			cpu: cpus()[0]?.model,
			graphNodes: nodes.length,
			graphEdges: edges.length,
			measuredQueries: 100,
			unmeasuredWarmupQueries: 5,
			iterationCap: 64,
			p50Ms: samples[49],
			p95Ms: samples[94],
			cpuMs: (used.user + used.system) / 1000,
			processPeakRssKiB: process.resourceUsage().maxRSS,
			maxResidual,
			externalModelCalls: 0,
			scopeOfMeasurement:
				'Graph validation, scoped normalization, diffusion and sorting; excludes document indexing, embeddings, language understanding and provider inference. RSS is whole-process high-water mark.',
		},
		null,
		2,
	)}\n`,
)

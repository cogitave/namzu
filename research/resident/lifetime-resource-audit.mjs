import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readProbeFile } from './lifetime-audit.mjs'

const [root, output] = process.argv.slice(2)
assert.ok(root?.startsWith('/tmp/namzu-lifetime-soak-') && output)
const producer = JSON.parse(await readProbeFile(join(root, 'result.json'), 8 * 1024 * 1024))
assert.equal(producer.passed, true)
assert.ok(producer.endedAt - producer.startedAt >= 7200000)
const bytes = await readProbeFile(join(root, 'resources.jsonl'), 8 * 1024 * 1024)
const observer = JSON.parse(await readProbeFile(join(root, 'resource-observer.json'), 65536))
const samples = bytes.toString('utf8').trim().split('\n').map(JSON.parse)
assert.equal(samples.length, observer.samples)
assert.ok(samples.length > 0 && samples.length <= 512)
const workers = new Map()
let previousAt = observer.startedAt
for (const sample of samples) {
	assert.ok(sample.at >= previousAt && sample.at <= observer.endedAt)
	previousAt = sample.at
	assert.ok(producer.workerPids.includes(sample.pid), 'Unrelated process in observer evidence.')
	if (sample.unavailable) continue
	assert.ok(
		[sample.cpuSeconds, sample.rssKiB, sample.peakRssKiB, sample.processStartTicks].every(
			(n) => Number.isFinite(n) && n >= 0,
		),
	)
	const previous = workers.get(sample.pid)
	if (previous) {
		assert.equal(
			previous.processStartTicks,
			sample.processStartTicks,
			'PID identity changed between samples.',
		)
		assert.ok(sample.cpuSeconds >= previous.lastCumulativeCpuSeconds)
	}
	workers.set(sample.pid, {
		pid: sample.pid,
		worker: producer.workerPids.indexOf(sample.pid) + 1,
		processStartTicks: sample.processStartTicks,
		samples: (previous?.samples ?? 0) + 1,
		firstElapsedMinutes: previous?.firstElapsedMinutes ?? (sample.at - producer.startedAt) / 60000,
		lastElapsedMinutes: (sample.at - producer.startedAt) / 60000,
		lastCumulativeCpuSeconds: sample.cpuSeconds,
		maximumObservedRssMiB: Math.max(previous?.maximumObservedRssMiB ?? 0, sample.rssKiB / 1024),
		maximumReportedPeakRssMiB: Math.max(
			previous?.maximumReportedPeakRssMiB ?? 0,
			sample.peakRssKiB / 1024,
		),
	})
}
assert.deepEqual([...workers.keys()].sort(), [...observer.observedPids].sort())
const result = {
	version: 1,
	root,
	sourceSha256: createHash('sha256').update(bytes).digest('hex'),
	producerStartedAt: producer.startedAt,
	producerEndedAt: producer.endedAt,
	observerStartedAt: observer.startedAt,
	observerEndedAt: observer.endedAt,
	expectedWorkers: producer.workerPids.length,
	observedWorkers: workers.size,
	unavailableSamples: samples.filter((s) => s.unavailable).length,
	workers: [...workers.values()],
	samples: samples.map((s) =>
		s.unavailable
			? { at: s.at, pid: s.pid, unavailable: true }
			: {
					at: s.at,
					pid: s.pid,
					worker: producer.workerPids.indexOf(s.pid) + 1,
					processStartTicks: s.processStartTicks,
					cpuSeconds: s.cpuSeconds,
					rssKiB: s.rssKiB,
					peakRssKiB: s.peakRssKiB,
					threads: s.threads,
				},
	),
	note: 'Late, approximate Linux procfs sampling. Short-lived workers can be missed. CPU values are cumulative at the last sample of each observed process, not exact total experiment CPU. RSS is not exact heap allocation or a memory leak test.',
}
await writeFile(output, JSON.stringify(result, null, 2) + '\n')
console.log(
	JSON.stringify({
		samples: samples.length,
		observedWorkers: workers.size,
		expectedWorkers: result.expectedWorkers,
		unavailableSamples: result.unavailableSamples,
	}),
)

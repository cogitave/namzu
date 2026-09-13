// Read-only Linux observer for an isolated lifecycle probe. Never signals a PID.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, readFile, readlink, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const root = resolve(process.argv[2] ?? '')
assert.ok(root.startsWith('/tmp/namzu-lifetime-soak-'))
const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
assert.ok(Number.isSafeInteger(ticksPerSecond) && ticksPerSecond > 0)
const startedAt = Date.now()
const samples = []
const readBounded = async (path, max) => {
	const info = await stat(path)
	if (info.size > max) throw new Error('Observer input exceeds its bound.')
	const text = await readFile(path, 'utf8')
	if (Buffer.byteLength(text) > max) throw new Error('Observer input grew beyond its bound.')
	return text
}
for (let i = 0; i < 512; i++) {
	const state = JSON.parse(await readBounded(join(root, 'result.json'), 8 * 1024 * 1024))
	assert.equal(state.root, root)
	if (state.endedAt) break
	const owner = [...state.commands].reverse().find((c) => c.result?.runner?.owner)?.result
		.runner.owner
	if (owner?.phase === 'running' && Number.isSafeInteger(owner.pid) && owner.pid > 1) {
		const sample = { at: Date.now(), pid: owner.pid, runnerId: owner.instanceId }
		try {
			// Check the private probe directory; retain start ticks for the final PID audit.
			assert.equal(await readlink(`/proc/${owner.pid}/cwd`), join(root, 'workspace'))
			const raw = await readBounded(`/proc/${owner.pid}/stat`, 16_384)
			const fields = raw
				.slice(raw.lastIndexOf(')') + 2)
				.trim()
				.split(/\s+/)
			const status = await readBounded(`/proc/${owner.pid}/status`, 32_768)
			const value = (name) =>
				Number(status.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? NaN)
			sample.processStartTicks = Number(fields[19])
			sample.cpuSeconds = (Number(fields[11]) + Number(fields[12])) / ticksPerSecond
			sample.rssKiB = value('VmRSS')
			sample.peakRssKiB = value('VmHWM')
			sample.threads = value('Threads')
			sample.requests = (await readBounded(join(root, 'requests.jsonl'), 8 * 1024 * 1024))
				.trim()
				.split('\n').length
			assert.ok(
				[
					sample.processStartTicks,
					sample.cpuSeconds,
					sample.rssKiB,
					sample.peakRssKiB,
					sample.threads,
				].every(Number.isFinite),
			)
		} catch (error) {
			sample.unavailable = error.code ?? error.message
		}
		samples.push(sample)
		await appendFile(join(root, 'resources.jsonl'), JSON.stringify(sample) + '\n')
	}
	await sleep(15_000)
}
const result = {
	startedAt,
	endedAt: Date.now(),
	ticksPerSecond,
	samples: samples.length,
	observedPids: [...new Set(samples.filter((s) => !s.unavailable).map((s) => s.pid))],
	note: 'Kernel-reported RSS is approximate. Sampling began after lifecycle startup and can miss short-lived workers; CPU and peak RSS are cumulative within each observed process.',
}
await writeFile(join(root, 'resource-observer.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))

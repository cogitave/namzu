// A stand-in for `namzu schedule __fire`: logs every 100 ms for a second,
// then writes its result. Its stdout is a file, so its parent dying does not
// kill it. argv: schedule __fire --home H --job J --run R ...
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1]
const home = arg('home')
const job = arg('job')
const run = arg('run')
let n = 0
const timer = setInterval(() => {
	process.stdout.write(`tick ${n++}\n`)
	if (n === 10) {
		clearInterval(timer)
		const dir = join(home, 'schedule', 'runs', job)
		mkdirSync(dir, { recursive: true })
		writeFileSync(
			join(dir, `${run}.json`),
			JSON.stringify({ v: 1, kind: 'schedule-run-result', runId: run, jobId: job, status: 'completed', exitCode: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }),
		)
	}
}, 100)

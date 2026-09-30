import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateScheduleJobId, generateScheduleRunId, hostCommandShell } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { type Sandbox, sandbox } from '../../__tests__/fixtures.js'
import { jobRequest } from '../../__tests__/fixtures.js'
import { buildJob, confirmJob } from '../../build.js'
import { MAX_SCRIPT_STATE_BYTES } from '../../fire/script-report.js'
import { createJob, deleteJob } from '../jobs.js'
import { readScriptState, scriptStatePath, writeScriptState } from '../script-state.js'

const boxes: Sandbox[] = []
afterEach(() => {
	for (const box of boxes.splice(0)) box.cleanup()
})

function setup() {
	const box = sandbox()
	boxes.push(box)
	return { box, jobId: generateScheduleJobId(), runId: generateScheduleRunId() }
}

describe('scheduler-owned script state', () => {
	it('starts empty, writes private atomic snapshots, and treats a retry as already applied', () => {
		const { box, jobId, runId } = setup()
		expect(readScriptState(box.paths, jobId)).toEqual({ revision: 0, state: '' })
		const first = writeScriptState(box.paths, jobId, 0, runId, '{"seen":[1]}')
		expect(first).toEqual({
			kind: 'written',
			snapshot: { revision: 1, state: '{"seen":[1]}', lastRunId: runId },
		})
		expect(writeScriptState(box.paths, jobId, 0, runId, '{"seen":[1]}')).toEqual({
			kind: 'already-applied',
			snapshot: first.snapshot,
		})
		expect(readScriptState(box.paths, jobId)).toEqual(first.snapshot)
		const file = scriptStatePath(box.paths, jobId)
		expect(statSync(file).mode & 0o777).toBe(0o600)
		expect(statSync(join(box.paths.root, 'script-state')).mode & 0o777).toBe(0o700)
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
			v: 1,
			kind: 'schedule-script-state',
			jobId,
			revision: 1,
			state: '{"seen":[1]}',
			lastRunId: runId,
		})
	})

	it('refuses stale and inconsistent results without rolling state back', () => {
		const { box, jobId, runId } = setup()
		writeScriptState(box.paths, jobId, 0, runId, 'first')
		const laterRun = generateScheduleRunId()
		expect(writeScriptState(box.paths, jobId, 0, laterRun, 'stale')).toEqual({
			kind: 'conflict',
			snapshot: { revision: 1, state: 'first', lastRunId: runId },
		})
		expect(() => writeScriptState(box.paths, jobId, 0, runId, 'changed')).toThrow(/different/)
		expect(writeScriptState(box.paths, jobId, 1, laterRun, '')).toEqual({
			kind: 'written',
			snapshot: { revision: 2, state: '', lastRunId: laterRun },
		})
	})

	it('rejects unsafe identifiers and state beyond the byte ceiling', () => {
		const { box, jobId, runId } = setup()
		expect(() => scriptStatePath(box.paths, '../escape')).toThrow(/invalid job id/)
		expect(() => writeScriptState(box.paths, jobId, -1, runId, '')).toThrow(/revision/)
		expect(() => writeScriptState(box.paths, jobId, 0, 'bad', '')).toThrow(/run id/)
		expect(() => writeScriptState(box.paths, jobId, 0, runId, 'a\0b')).toThrow(/NUL/)
		expect(() => writeScriptState(box.paths, jobId, 0, runId, '\ud800')).toThrow(/Unicode/)
		expect(() =>
			writeScriptState(box.paths, jobId, 0, runId, '🙂'.repeat(MAX_SCRIPT_STATE_BYTES / 4 + 1)),
		).toThrow(/bytes/)
	})

	it('refuses a damaged state document rather than treating it as empty', () => {
		const { box, jobId } = setup()
		writeScriptState(box.paths, jobId, 0, generateScheduleRunId(), 'good')
		const file = scriptStatePath(box.paths, jobId)
		writeFileSync(
			file,
			'{"v":1,"kind":"schedule-script-state","jobId":"foreign","revision":1,"state":"bad"}',
		)
		expect(() => readScriptState(box.paths, jobId)).toThrow(/invalid/)
	})

	it('refuses a stored NUL before it can reach a child process environment', () => {
		const { box, jobId, runId } = setup()
		writeScriptState(box.paths, jobId, 0, runId, 'safe')
		const file = scriptStatePath(box.paths, jobId)
		writeFileSync(
			file,
			JSON.stringify({
				v: 1,
				kind: 'schedule-script-state',
				jobId,
				revision: 1,
				state: 'a\0b',
				lastRunId: runId,
			}),
		)
		expect(() => readScriptState(box.paths, jobId)).toThrow(/invalid/)
	})

	it('refuses a stored lone surrogate before it can change in the next process', () => {
		const { box, jobId, runId } = setup()
		writeScriptState(box.paths, jobId, 0, runId, 'safe')
		const file = scriptStatePath(box.paths, jobId)
		writeFileSync(
			file,
			JSON.stringify({
				v: 1,
				kind: 'schedule-script-state',
				jobId,
				revision: 1,
				state: '\ud800',
				lastRunId: runId,
			}),
		)
		expect(() => readScriptState(box.paths, jobId)).toThrow(/invalid/)
	})

	it('removes an opaque checkpoint with its job definition', () => {
		const { box, runId } = setup()
		const job = createJob(
			box.paths,
			confirmJob(
				buildJob(
					jobRequest(box, {
						runKind: 'script',
						script: { body: 'echo done', shell: hostCommandShell().dialect, report: 'json-v1' },
						permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
					}),
					{
						paths: box.paths,
						config: {},
						now: new Date(),
						osHome: box.osHome,
					},
				),
				'cli-tty',
				new Date(),
				{ paths: box.paths },
			),
		)
		writeScriptState(box.paths, job.id, 0, runId, 'private checkpoint')
		expect(existsSync(scriptStatePath(box.paths, job.id))).toBe(true)
		deleteJob(box.paths, job.id)
		expect(existsSync(scriptStatePath(box.paths, job.id))).toBe(false)
	})
})

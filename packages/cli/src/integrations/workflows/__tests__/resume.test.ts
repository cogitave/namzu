import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { completionNotice, launchedText } from '../notice.js'
import {
	controlCharacterProblem,
	describeResume,
	editableCopyPath,
	resumeCallText,
	resumeReviewLines,
	workflowJournalKey,
} from '../resume.js'
import { viewFromJournal } from '../view.js'
import { workflowHarness } from './harness.js'

const SCRIPT =
	"export const meta = { name: 'R', description: 'd' }\nreturn [await agent('a'), await agent('b')]"

describe('script text rules', () => {
	it('rejects an escape byte and a lone carriage return only', () => {
		expect(controlCharacterProblem('a\u001bb')).toContain('control character')
		expect(controlCharacterProblem('a\rb')).toContain('control character')
		expect(controlCharacterProblem('a\r\nb\n')).toBeUndefined()
		expect(controlCharacterProblem('tab\there')).toBeUndefined()
	})
})

describe('the journal secret', () => {
	const dirs: string[] = []
	afterEach(() => {
		for (const dir of dirs.splice(0)) removeTempDir(dir)
	})
	it('is made once, private, and read back the same', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-key-'))
		dirs.push(home)
		const first = workflowJournalKey(home)
		expect(first).toMatch(/^[0-9a-f]{64}$/)
		expect(workflowJournalKey(home)).toBe(first)
		expect(statSync(join(home, 'workflow-journal.key')).mode & 0o777).toBe(0o600)
	})
	it('is absent when the folder cannot hold it', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-key-'))
		dirs.push(home)
		writeFileSync(join(home, 'file'), 'x')
		expect(workflowJournalKey(join(home, 'file', 'inner'))).toBeUndefined()
	})
})

describe('the resume review', () => {
	const open: Awaited<ReturnType<typeof workflowHarness>>[] = []
	afterEach(async () => {
		for (const h of open.splice(0)) {
			await h.close()
			removeTempDir(h.cwd)
		}
	})

	async function finishedRun() {
		const h = await workflowHarness()
		open.push(h)
		const result = await h.start({ script: SCRIPT })
		const runId = (result.data as { run_id: string }).run_id
		await h.untilEnded()
		return { h, runId }
	}

	it('counts saved results exactly for an unchanged script', async () => {
		const { h, runId } = await finishedRun()
		const review = describeResume(h.runs, runId, SCRIPT)
		expect(review).toMatchObject({ resumable: true, pass: 2, saved: 2, unfinished: 0, failed: 0 })
		expect(review.scriptChanged).toBe(false)
		const lines = resumeReviewLines(review)
		expect(lines[0]).toBe(`Resumes run ${runId} (pass 2; the previous pass completed)`)
		expect(lines.join('\n')).toContain('About 2 agents return saved results')
		expect(lines.join('\n')).toContain('Script: unchanged since the run started')
	})

	it('words the figures as an upper bound when the script was edited', async () => {
		const { h, runId } = await finishedRun()
		const review = describeResume(h.runs, runId, SCRIPT.replace("'b'", "'c'"))
		const text = resumeReviewLines(review).join('\n')
		expect(text).toContain('Up to 2 agents can return saved results')
		expect(text).toContain('edited since the run started')
	})

	it('names a journal that was changed', async () => {
		const { h, runId } = await finishedRun()
		const file = join(h.runs, runId, 'workflow', 'journal.jsonl')
		const lines = readFileSync(file, 'utf8').split('\n')
		lines[2] = (lines[2] as string).replace('"index":1', '"index":9')
		writeFileSync(file, lines.join('\n'))
		const review = describeResume(h.runs, runId, SCRIPT)
		expect(review.brokenAt).toBeDefined()
		expect(resumeReviewLines(review).join('\n')).toContain('changed or cut short at line')
	})

	it('says plainly when there is nothing to resume', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-none-'))
		const review = describeResume(dir, 'wzzzzzzzz', SCRIPT)
		expect(review.resumable).toBe(false)
		expect(resumeReviewLines(review)[0]).toContain('cannot be resumed')
		expect(describeResume(dir, 'bad', SCRIPT).problems[0]).toContain('not a workflow run id')
		removeTempDir(dir)
	})
})

describe('what the model and the list read', () => {
	it('puts the script file, run id and resume call in the receipt', () => {
		const text = launchedText({
			runId: 'wabcdefgh',
			name: 'N',
			scriptPath: '/s/n-wabcdefgh.js',
			journalPath: '/r/journal.jsonl',
		})
		expect(text).toContain('Script file: /s/n-wabcdefgh.js')
		expect(text).toContain('Run ID: wabcdefgh')
		expect(text).toContain(resumeCallText('/s/n-wabcdefgh.js', 'wabcdefgh'))
		expect(text).toContain('read /r/journal.jsonl before assuming')
		expect(launchedText({ runId: 'wabcdefgh', name: 'N' })).not.toContain('Script file')
	})

	it('adds a recovery block to a failed run and a diagnostics line to a finished one', async () => {
		const h = await workflowHarness()
		const result = await h.start({
			script:
				"export const meta = { name: 'F', description: 'd' }\nawait agent('a')\nthrow new Error('later')",
		})
		await h.untilEnded()
		void result
		const failed = h.ended[0]?.view
		expect(failed?.status).toBe('failed')
		const text = completionNotice(failed as NonNullable<typeof failed>)
		expect(text).toContain('<recovery>')
		expect(text).toContain('resumeFromRunId')
		expect(text).toContain('agents_cached: 0')
		await h.close()
		removeTempDir(h.cwd)
	})

	it('shows only the latest pass of a resumed run and marks cached agents', () => {
		const at = 1
		const usage = {
			agents: 0,
			agentsDone: 0,
			agentsFailed: 0,
			agentsSkipped: 0,
			tokens: 0,
			toolCalls: 0,
			elapsedMs: 0,
		}
		const meta = { name: 'N', description: 'd', phases: [] }
		const base = {
			runId: 'wabcdefgh',
			scriptSha256: 's',
			scriptBytes: 1,
			meta,
			args: {},
			limits: {} as never,
		}
		const request = (index: number, pass: number) => ({
			type: 'agent_request' as const,
			at,
			index,
			label: `L${index}`,
			promptPreview: 'p',
			promptSha256: 'h',
			options: { schema: false },
			pass,
			seq: 1,
			prev: 'x',
		})
		const outcome = (index: number, pass: number, extra = {}) => ({
			type: 'agent_outcome' as const,
			at,
			index,
			state: 'done' as const,
			tokens: 1,
			toolCalls: 0,
			queuedAt: at,
			finishedAt: at,
			pass,
			seq: 1,
			prev: 'x',
			...extra,
		})
		const view = viewFromJournal([
			{ type: 'run_started', at, ...base, seq: 1, prev: 'x' },
			request(1, 1),
			request(2, 1),
			outcome(1, 1),
			outcome(2, 1, {
				state: 'error',
				interrupted: true,
				error: 'The workflow was stopped before this agent finished.',
			}),
			{ type: 'run_finished', at, status: 'stopped', usage, seq: 1, prev: 'x' },
			{
				type: 'run_started',
				at: 2,
				...base,
				resume: { pass: 2, previousFinish: 'stopped', scriptSha256Changed: false },
				seq: 1,
				prev: 'x',
			},
			request(1, 2),
			outcome(1, 2, { cached: true }),
			// a straggler of the first pass written after the second began
			outcome(2, 1),
		] as never)
		expect(view?.pass).toBe(2)
		expect(view?.agents).toHaveLength(1)
		expect(view?.agents[0]).toMatchObject({ index: 1, status: 'done', cached: true })
		expect(view?.status).toBe('stopped')
		expect(view?.resumable).toBe('yes')
		const unchained = [
			{ type: 'run_started', at, ...base },
			request(1, 1),
			outcome(2, 1, { state: 'error', interrupted: true, error: 'x' }),
		].map(({ seq: _seq, prev: _prev, ...rest }: Record<string, unknown>) => rest)
		const first = viewFromJournal(unchained as never)
		expect(first?.resumable).toBe('legacy')
		expect(editableCopyPath('/s/runs', 'My Fancy / Name!', 'wabcdefgh')).toBe(
			'/s/workflows/scripts/my-fancy-name-wabcdefgh.js',
		)
	})
})

import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileWorkflowJournal } from '../journal.js'
import {
	loadWorkflowResume,
	readWorkflowJournalChecked,
	workflowCallKey,
	workflowJournalLineHash,
	workflowJournalSeed,
} from '../resume.js'
import type { WorkflowJournalRecord } from '../types.js'

const RUN = 'wabcdefgh'
const usage = {
	agents: 0,
	agentsDone: 0,
	agentsFailed: 0,
	agentsSkipped: 0,
	tokens: 0,
	toolCalls: 0,
	elapsedMs: 0,
}
const started = (resume?: { pass: number }): WorkflowJournalRecord => ({
	type: 'run_started',
	at: 1,
	runId: RUN,
	scriptSha256: 'aa',
	scriptBytes: 1,
	meta: { name: 'n', description: 'd', phases: [] },
	args: {},
	limits: {} as never,
	...(resume
		? {
				resume: {
					...resume,
					previousFinish: 'unfinished' as const,
					scriptSha256Changed: false,
				},
			}
		: {}),
})
const request = (index: number, key: string, pass = 1): WorkflowJournalRecord => ({
	type: 'agent_request',
	at: 1,
	index,
	label: 'l',
	promptPreview: 'p',
	promptSha256: 'h',
	options: { schema: false },
	key,
	pass,
})
const outcome = (
	index: number,
	key: string,
	extra: Partial<Extract<WorkflowJournalRecord, { type: 'agent_outcome' }>> = {},
	pass = 1,
): WorkflowJournalRecord => ({
	type: 'agent_outcome',
	at: 2,
	index,
	state: 'done',
	tokens: 1,
	toolCalls: 0,
	queuedAt: 1,
	finishedAt: 2,
	key,
	pass,
	...extra,
})
const finished = (status: 'completed' | 'failed' | 'stopped'): WorkflowJournalRecord => ({
	type: 'run_finished',
	at: 3,
	status,
	usage,
})

let dir: string
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'wf-resume-'))
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

async function write(records: WorkflowJournalRecord[]): Promise<FileWorkflowJournal> {
	const journal = new FileWorkflowJournal(dir, { runId: RUN })
	for (const record of records) await journal.append(record)
	return journal
}

describe('workflowCallKey', () => {
	const base = workflowCallKey('p', { model: 'm' }, 0)
	it('is stable and versioned', () => {
		expect(workflowCallKey('p', { model: 'm' }, 0)).toBe(base)
		expect(base).toMatch(/^k1:[0-9a-f]{64}$/)
	})
	it('changes with the prompt, each option and the ordinal', () => {
		const keys = new Set([
			base,
			workflowCallKey('q', { model: 'm' }, 0),
			workflowCallKey('p', { model: 'n' }, 0),
			workflowCallKey('p', { model: 'm', effort: 'high' }, 0),
			workflowCallKey('p', { model: 'm', agentType: 'a' }, 0),
			workflowCallKey('p', { model: 'm', schema: { type: 'object' } }, 0),
			workflowCallKey('p', { model: 'm', schema: { type: 'string' } }, 0),
			workflowCallKey('p', { model: 'm' }, 1),
		])
		expect(keys.size).toBe(8)
	})
	it('ignores label-like fields, option and schema key order, and __proto__', () => {
		const a = workflowCallKey('p', { schema: { a: 1, b: { c: 2, d: 3 } } }, 0)
		const b = workflowCallKey(
			'p',
			{ schema: JSON.parse('{"b":{"d":3,"c":2},"a":1,"__proto__":{"x":1}}') },
			0,
		)
		expect(b).toBe(a)
		expect(workflowCallKey('p', { ...({ label: 'x', phase: 'y' } as object) }, 0)).toBe(
			workflowCallKey('p', {}, 0),
		)
	})
	it('does not let the prompt run into the options', () => {
		expect(workflowCallKey('a{}', {}, 0)).not.toBe(workflowCallKey('a', {}, 0))
		expect(workflowCallKey('x\u00001', {}, 0)).not.toBe(workflowCallKey('x', {}, 10))
	})
})

describe('journal chain', () => {
	it('chains every line to the one before and to the run id', async () => {
		await write([started(), request(1, 'k1'), outcome(1, 'k1', { result: 'v' })])
		const checked = await new FileWorkflowJournal(dir, { runId: RUN }).read()
		expect(checked.records.map((r) => r.seq)).toEqual([1, 2, 3])
		expect(checked.records[0]?.prev).toBe(workflowJournalSeed(RUN))
		expect(checked.brokenAt).toBeUndefined()
		expect(checked.legacy).toBe(false)
		const text = await readFile(join(dir, 'journal.jsonl'), 'utf8')
		expect(readWorkflowJournalChecked(text, 'wzzzzzzzz').records).toEqual([])
	})

	async function lines(): Promise<string[]> {
		return (await readFile(join(dir, 'journal.jsonl'), 'utf8')).split('\n').slice(0, -1)
	}
	const check = async (ls: string[]) => readWorkflowJournalChecked(`${ls.join('\n')}\n`, RUN)

	it('finds an edited line at the line after it', async () => {
		await write([started(), request(1, 'k1'), outcome(1, 'k1', { result: 'v' })])
		const ls = await lines()
		const middle = [ls[0] as string, (ls[1] as string).replace('k1', 'kX'), ls[2] as string]
		const c = await check(middle)
		expect(c.records).toHaveLength(2)
		expect(c.brokenAt).toBe(3)
	})

	it('finds an edit to the last line only with a key', async () => {
		const key = 'secret'
		const journal = new FileWorkflowJournal(dir, { runId: RUN, key })
		for (const r of [started(), request(1, 'k1'), outcome(1, 'k1', { result: 'v' })]) {
			await journal.append(r)
		}
		const ls = await lines()
		const edited = [...ls.slice(0, 2), (ls[2] as string).replace('"v"', '"w"')]
		const text = `${edited.join('\n')}\n`
		expect(readWorkflowJournalChecked(text, RUN).records).toHaveLength(3)
		const keyed = readWorkflowJournalChecked(text, RUN, { key })
		expect(keyed.records).toHaveLength(2)
		expect(keyed.brokenAt).toBe(3)
		expect((await journal.read()).records).toHaveLength(3)
		const wrongKey = readWorkflowJournalChecked(`${ls.join('\n')}\n`, RUN, {
			key: 'other',
		})
		expect(wrongKey.records).toHaveLength(0)
	})

	it('finds a deleted, a swapped and a truncated line', async () => {
		await write([
			started(),
			request(1, 'k1'),
			outcome(1, 'k1', { result: 'v' }),
			finished('completed'),
		])
		const ls = await lines()
		expect((await check([ls[0], ls[2], ls[3]] as string[])).brokenAt).toBe(2)
		expect((await check([ls[0], ls[2], ls[1], ls[3]] as string[])).brokenAt).toBe(2)
		const cut = await check(ls.slice(0, 2))
		expect(cut.brokenAt).toBeUndefined()
		expect(cut.records).toHaveLength(2)
	})

	it('rejects a last line whose chain does not match', async () => {
		await write([started(), request(1, 'k1')])
		const ls = await lines()
		const forged = JSON.stringify({
			seq: 3,
			prev: 'f'.repeat(64),
			...outcome(1, 'k1', { result: 'x' }),
		})
		const c = await check([...ls, forged])
		expect(c.records).toHaveLength(2)
		expect(c.brokenAt).toBe(3)
	})

	it('ignores a torn last line and re-anchors on the next pass', async () => {
		await write([started(), request(1, 'k1'), outcome(1, 'k1', { result: 'v' })])
		await appendFile(join(dir, 'journal.jsonl'), '{"seq":4,"prev":"abc","type":"agent_re')
		const torn = await new FileWorkflowJournal(dir, { runId: RUN }).read()
		expect(torn.tornTail).toBe(true)
		expect(torn.endsWithNewline).toBe(false)
		expect(torn.records).toHaveLength(3)
		expect(torn.brokenAt).toBeUndefined()

		// A new process resumes: its first record closes the fragment with a newline and chains from line 3.
		const again = new FileWorkflowJournal(dir, { runId: RUN })
		await again.append(started({ pass: 2 }))
		await again.append(request(1, 'k1', 2))
		const after = await new FileWorkflowJournal(dir, { runId: RUN }).read()
		expect(after.records.map((r) => r.type)).toEqual([
			'run_started',
			'agent_request',
			'agent_outcome',
			'run_started',
			'agent_request',
		])
		expect(after.brokenAt).toBeUndefined()
		expect(after.tornTail).toBe(false)
	})

	it('trusts a last line that is whole JSON and only lacks its newline', async () => {
		await write([started(), request(1, 'k1'), outcome(1, 'k1', { result: 'v' })])
		const file = join(dir, 'journal.jsonl')
		const text = await readFile(file, 'utf8')
		await writeFile(file, text.slice(0, -1))
		const cut = await new FileWorkflowJournal(dir, { runId: RUN }).read()
		expect(cut.tornTail).toBe(false)
		expect(cut.endsWithNewline).toBe(false)
		expect(cut.records).toHaveLength(3)
		expect(loadWorkflowResume(cut).results.get('k1')?.value).toBe('v')

		const again = new FileWorkflowJournal(dir, { runId: RUN })
		await again.append(started({ pass: 2 }))
		await again.append(request(1, 'k1', 2))
		const after = await new FileWorkflowJournal(dir, { runId: RUN }).read()
		expect(after.records.map((r) => r.type)).toEqual([
			'run_started',
			'agent_request',
			'agent_outcome',
			'run_started',
			'agent_request',
		])
		expect(after.brokenAt).toBeUndefined()
	})

	it('reads and extends a journal in a folder that is not named after the run', async () => {
		await write([started(), request(1, 'k1'), outcome(1, 'k1', { result: 'v' })])
		// Neither the first reader nor the second is told the run id.
		const read = await new FileWorkflowJournal(dir).read()
		expect(read.records).toHaveLength(3)
		const other = new FileWorkflowJournal(dir)
		await other.append(finished('completed'))
		const after = await new FileWorkflowJournal(dir).read()
		expect(after.records.map((r) => r.seq)).toEqual([1, 2, 3, 4])
		expect(after.brokenAt).toBeUndefined()
	})

	it('keeps trust after a real break once a later pass re-anchors, and reports it', async () => {
		await write([started(), request(1, 'k1'), outcome(1, 'k1', { result: 'v' })])
		const ls = await lines()
		const damaged = [ls[0] as string, ls[2] as string]
		await writeFile(join(dir, 'journal.jsonl'), `${damaged.join('\n')}\n`)
		// Another process changed the file: the writer notices the size and rebuilds its chain.
		const text = await readFile(join(dir, 'journal.jsonl'), 'utf8')
		const c = readWorkflowJournalChecked(text, RUN)
		expect(c.records).toHaveLength(1)
		expect(c.brokenAt).toBe(2)
		// The next pass chains from the last trusted line.
		const next = JSON.stringify({
			seq: c.lastSeq + 1,
			prev: c.lastHash,
			...started({ pass: 2 }),
		})
		const merged = readWorkflowJournalChecked(`${text}${next}\n`, RUN)
		expect(merged.records.map((r) => r.type)).toEqual(['run_started', 'run_started'])
		expect(merged.brokenAt).toBe(2)
		await writeFile(join(dir, 'journal.jsonl'), text)
		const writer = new FileWorkflowJournal(dir, { runId: RUN })
		await writer.append(started({ pass: 2 }))
		const healed = await writer.read()
		expect(healed.records.map((r) => r.type)).toEqual(['run_started', 'run_started'])
		expect(healed.brokenAt).toBe(2)
		expect(workflowJournalLineHash(next)).toBe(merged.lastHash)
	})

	it('reports an old journal without chain fields as legacy', () => {
		const text = `${JSON.stringify(started())}\n${JSON.stringify(request(1, 'k1'))}\n`
		const c = readWorkflowJournalChecked(text, RUN)
		expect(c.legacy).toBe(true)
		expect(c.records).toEqual([])
		expect(c.untrusted).toHaveLength(2)
		expect(loadWorkflowResume(c)).toMatchObject({ resumable: false })
		expect(loadWorkflowResume(c).problems[0]).toContain('before resuming was possible')
	})

	it('treats an empty or missing journal as nothing to resume', async () => {
		const c = await new FileWorkflowJournal(join(dir, 'nope'), {
			runId: RUN,
		}).read()
		expect(c.records).toEqual([])
		expect(loadWorkflowResume(c).resumable).toBe(false)
	})

	it('drops appends after run_finished until the next pass starts', async () => {
		const journal = await write([started(), request(1, 'k1'), finished('stopped')])
		await journal.append(outcome(1, 'k1', { result: 'late' }))
		expect((await journal.read()).records).toHaveLength(3)
		await journal.append(started({ pass: 2 }))
		expect((await journal.read()).records).toHaveLength(4)
	})

	it('writes pass scripts to separate files', async () => {
		const journal = new FileWorkflowJournal(dir, { runId: RUN })
		await journal.writeScript('one', 'h', 1)
		await journal.writeScript('two', 'h', 2)
		expect(await readFile(join(dir, 'script.js'), 'utf8')).toBe('one')
		expect(await readFile(join(dir, 'script.2.js'), 'utf8')).toBe('two')
	})
})

describe('loadWorkflowResume', () => {
	const load = async (records: WorkflowJournalRecord[]) => {
		await write(records)
		return loadWorkflowResume(await new FileWorkflowJournal(dir, { runId: RUN }).read())
	}

	it('keeps the last saved result per key and counts passes', async () => {
		const s = await load([
			started(),
			request(1, 'a'),
			outcome(1, 'a', { result: 'one' }),
			request(2, 'a'),
			outcome(2, 'a', { result: 'two' }),
			finished('completed'),
		])
		expect(s.results.get('a')).toMatchObject({
			value: 'two',
			index: 2,
			pass: 1,
		})
		expect(s.pass).toBe(2)
		expect(s.previousFinish).toBe('completed')
		expect(s.resumable).toBe(true)
	})

	it('a later live request demotes a saved result until it finishes again', async () => {
		const s = await load([
			started(),
			outcome(1, 'a', { result: 'one' }),
			started({ pass: 2 }),
			request(1, 'a', 2),
		])
		expect(s.results.has('a')).toBe(false)
		expect(s.demoted.has('a')).toBe(true)
		expect(s.previousFinish).toBe('unfinished')
		expect(s.pass).toBe(3)
	})

	it('an error or a skip deletes the result and marks the key failed', async () => {
		const s = await load([
			started(),
			outcome(1, 'a', { result: 'one' }),
			outcome(2, 'b', { state: 'error', error: 'boom' }),
			outcome(3, 'c', { state: 'skipped' }),
		])
		expect([...s.failed].sort()).toEqual(['b', 'c'])
		expect([...s.results.keys()]).toEqual(['a'])
	})

	it('an interrupted agent is seen but neither failed nor demoted', async () => {
		const s = await load([
			started(),
			request(1, 'a'),
			outcome(1, 'a', { state: 'error', error: 'stopped', interrupted: true }),
			request(2, 'b'),
		])
		expect(s.seen.has('a')).toBe(true)
		expect(s.failed.has('a')).toBe(false)
		expect(s.demoted.has('a')).toBe(false)
		expect(s.seen.has('b')).toBe(true)
	})

	it('skips cached lines and records of a pass older than the latest start', async () => {
		const s = await load([
			started(),
			outcome(1, 'a', { result: 'one' }),
			started({ pass: 2 }),
			outcome(1, 'a', { cached: true, resultFrom: { pass: 1, index: 1 } }, 2),
			// a slow agent of pass 1 finishing after pass 2 began
			outcome(2, 'b', { result: 'stale' }, 1),
		])
		expect(s.results.get('a')).toMatchObject({ value: 'one', pass: 1 })
		expect(s.results.has('b')).toBe(false)
		expect(s.seen.has('b')).toBe(false)
	})

	it('an unsaved value runs again and closes the cache', async () => {
		const s = await load([started(), outcome(1, 'a', { unsaved: true })])
		expect(s.demoted.has('a')).toBe(true)
		expect(s.results.size).toBe(0)
	})

	it('reports a broken chain in plain words', async () => {
		await write([started(), request(1, 'a'), outcome(1, 'a', { result: 'x' })])
		const text = (await readFile(join(dir, 'journal.jsonl'), 'utf8')).split('\n')
		text[1] = (text[1] as string).replace('"a"', '"z"')
		const c = readWorkflowJournalChecked(text.join('\n'), RUN)
		const s = loadWorkflowResume(c)
		expect(s.brokenAt).toBe(3)
		expect(s.problems.join(' ')).toContain('changed or cut short at line 3')
		expect(s.results.size).toBe(0)
	})
})

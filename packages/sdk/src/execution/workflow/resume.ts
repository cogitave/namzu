import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import type {
	ChainedWorkflowJournalRecord,
	CheckedWorkflowJournal,
	WorkflowFinishStatus,
	WorkflowJournalRecord,
	WorkflowResumeState,
} from './types.js'

/** The key version. A change to how keys are made bumps it, so old keys simply never match. */
const KEY_VERSION = 'k1'

function sha256Hex(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

/** JSON with every object's keys sorted and `__proto__` dropped, so equal values give equal text. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
	if (typeof value === 'object' && value !== null) {
		const record = value as Record<string, unknown>
		const keys = Object.keys(record)
			.filter((key) => key !== '__proto__' && record[key] !== undefined)
			.sort()
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

/** What of an `agent()` call decides its result. `label`, `phase` and progress callbacks do not. */
export interface WorkflowCallIdentity {
	readonly schema?: unknown
	readonly model?: string
	readonly effort?: string
	readonly agentType?: string
}

/**
 * The key a call is saved and looked up under: the prompt, the options that
 * change what the agent does (schema, model, effort, agent type) and how many
 * identical calls came before it in the same pass. Each part is length-prefixed
 * so one cannot be read as part of another.
 */
export function workflowCallKey(
	prompt: string,
	call: WorkflowCallIdentity,
	ordinal: number,
): string {
	const options = canonicalJson({
		schema: call.schema,
		model: call.model,
		effort: call.effort,
		agentType: call.agentType,
	})
	const preimage = `${prompt.length}:${prompt}${options.length}:${options}${ordinal}`
	return `${KEY_VERSION}:${sha256Hex(preimage)}`
}

/** The hash the first line of a run's journal chains from. It binds the file to its run id. */
export function workflowJournalSeed(runId: string): string {
	return sha256Hex(`namzu-workflow-journal\0${runId}`)
}

/** The hash a line contributes to the next one: its exact bytes, newline included. */
export function workflowJournalLineHash(line: string): string {
	return sha256Hex(`${line}\n`)
}

/** The line `record` is written as. With a key, a `mac` over the rest of the line is added last. */
export function formatWorkflowJournalLine(
	record: WorkflowJournalRecord,
	seq: number,
	prev: string,
	key?: string | Uint8Array,
): string {
	const body = { seq, prev, ...record }
	if (key === undefined) return JSON.stringify(body)
	const mac = createHmac('sha256', key).update(JSON.stringify(body)).digest('hex')
	return JSON.stringify({ ...body, mac })
}

function macMatches(record: Record<string, unknown>, key: string | Uint8Array): boolean {
	const { mac, ...rest } = record
	if (typeof mac !== 'string') return false
	const expected = createHmac('sha256', key).update(JSON.stringify(rest)).digest()
	const actual = Buffer.from(mac, 'hex')
	return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line)
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

/**
 * Reads a journal's text and keeps only the records that can be trusted.
 *
 * Every line carries `seq` (counting trusted lines from 1) and `prev` (the hash
 * of the line before; the first chains from a seed bound to the run id). A
 * line that does not chain, a line that does not parse, and anything after
 * one is dropped until a `run_started` of a resumed pass picks the chain up
 * again at the last trusted line. A last line without its newline is a torn
 * write and is ignored. The file is never rewritten.
 *
 * The chain alone cannot notice an edit to the final line (nothing chains from
 * it yet). With `key`, every line must also carry a `mac` made with that
 * secret, which closes that gap against anyone who does not hold the key.
 */
export function readWorkflowJournalChecked(
	text: string,
	runId: string,
	options: { readonly key?: string | Uint8Array } = {},
): CheckedWorkflowJournal {
	const endsWithNewline = text === '' || text.endsWith('\n')
	const pieces = text.split('\n')
	const fragment = endsWithNewline ? undefined : pieces.pop()
	if (endsWithNewline) pieces.pop()
	const tornTail = fragment !== undefined && fragment !== ''

	const parsed = pieces.map((line) => parseLine(line))
	const firstRecord = parsed.find((record) => record !== undefined)
	if (firstRecord !== undefined && typeof firstRecord.seq !== 'number') {
		return {
			records: [],
			legacy: true,
			tornTail,
			lastSeq: 0,
			lastHash: workflowJournalSeed(runId),
			endsWithNewline,
			untrusted: parsed.filter((record) => record !== undefined) as WorkflowJournalRecord[],
		}
	}

	const records: ChainedWorkflowJournalRecord[] = []
	let lastSeq = 0
	let lastHash = workflowJournalSeed(runId)
	let gapStart: number | undefined
	let gapLines = 0
	let gapParsed = false
	let brokenAt: number | undefined
	const closeGap = (): void => {
		if (gapStart !== undefined && (gapLines > 1 || gapParsed)) brokenAt ??= gapStart
		gapStart = undefined
		gapLines = 0
		gapParsed = false
	}

	for (let i = 0; i < pieces.length; i++) {
		const line = pieces[i] as string
		const record = parsed[i]
		const chains =
			record !== undefined &&
			record.seq === lastSeq + 1 &&
			record.prev === lastHash &&
			(options.key === undefined || macMatches(record, options.key))
		const first = records.length === 0
		const acceptable =
			chains &&
			(first
				? record.type === 'run_started' && record.runId === runId
				: gapStart === undefined || record.type === 'run_started')
		if (acceptable) {
			closeGap()
			records.push(record as unknown as ChainedWorkflowJournalRecord)
			lastSeq = record.seq as number
			lastHash = workflowJournalLineHash(line)
			continue
		}
		if (gapStart === undefined) gapStart = i + 1
		gapLines++
		if (record !== undefined) gapParsed = true
	}
	// A gap that runs to the end is a change, except a single line that does not parse
	// (what a torn write leaves once the next pass closed it with a newline).
	closeGap()

	return {
		records,
		legacy: false,
		tornTail,
		...(brokenAt !== undefined ? { brokenAt } : {}),
		lastSeq,
		lastHash,
		endsWithNewline,
		untrusted: [],
	}
}

function hasResult(record: { readonly result?: unknown }): boolean {
	return Object.hasOwn(record, 'result') && record.result !== undefined && record.result !== null
}

/**
 * Folds a checked journal into what a resumed pass needs.
 *
 * The last saved result for a key wins. An agent that was asked for again
 * after a result was saved gives that result up until it finishes again. A
 * failed or skipped outcome removes the result and marks the key failed; an
 * outcome the run recorded as interrupted (stopped, not failed) leaves the key
 * as seen but unfinished. Lines marked `cached` repeat an earlier result and
 * are skipped, and so is any agent record from a pass older than the latest
 * `run_started`, which a slow agent of an earlier pass can still write.
 */
export function loadWorkflowResume(checked: CheckedWorkflowJournal): WorkflowResumeState {
	const results = new Map<
		string,
		{ value: unknown; pass: number; index: number; childSessionId?: string }
	>()
	const seen = new Set<string>()
	const failed = new Set<string>()
	const demoted = new Set<string>()
	const problems: string[] = []
	const keysByIndex = new Map<string, string>()
	let currentPass = 0
	let scriptSha256: string | undefined
	let previousFinish: WorkflowFinishStatus | 'unfinished' = 'unfinished'

	for (const record of checked.records) {
		if (record.type === 'run_started') {
			currentPass = record.resume?.pass ?? 1
			scriptSha256 = record.scriptSha256
			previousFinish = 'unfinished'
			keysByIndex.clear()
			continue
		}
		if (record.type === 'run_finished') {
			previousFinish = record.status
			continue
		}
		if (record.type !== 'agent_request' && record.type !== 'agent_outcome') continue
		const pass = record.pass ?? 1
		if (pass < currentPass || record.cached === true) continue
		if (record.type === 'agent_request') {
			if (record.key === undefined) continue
			keysByIndex.set(`${pass}:${record.index}`, record.key)
			seen.add(record.key)
			if (results.delete(record.key)) demoted.add(record.key)
			continue
		}
		const key = record.key ?? keysByIndex.get(`${pass}:${record.index}`)
		if (key === undefined) continue
		seen.add(key)
		if (record.state === 'done' && hasResult(record)) {
			results.set(key, {
				value: record.result,
				pass,
				index: record.index,
				...(record.childSessionId !== undefined ? { childSessionId: record.childSessionId } : {}),
			})
			failed.delete(key)
			demoted.delete(key)
		} else if (record.state === 'done' && record.unsaved === true) {
			results.delete(key)
			demoted.add(key)
		} else if (record.interrupted === true) {
			// Stopped, not failed: the agent runs again and the cache stays open.
			results.delete(key)
		} else {
			results.delete(key)
			demoted.delete(key)
			failed.add(key)
		}
	}

	if (checked.legacy) {
		problems.push(
			'This run was saved before resuming was possible, so its agents cannot be reused.',
		)
	}
	if (checked.brokenAt !== undefined) {
		problems.push(
			`The journal was changed or cut short at line ${checked.brokenAt}. Results after that point are not trusted and those agents will run again.`,
		)
	}
	const started = checked.records.some((record) => record.type === 'run_started')
	if (!checked.legacy && !started) problems.push('The journal has no usable record of the run.')

	return {
		pass: currentPass + 1,
		results,
		seen,
		failed,
		demoted,
		...(scriptSha256 !== undefined ? { scriptSha256 } : {}),
		previousFinish,
		problems,
		resumable: !checked.legacy && started,
		...(checked.brokenAt !== undefined ? { brokenAt: checked.brokenAt } : {}),
	}
}

import { createHash } from 'node:crypto'
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
	formatWorkflowJournalLine,
	readWorkflowJournalChecked,
	workflowJournalLineHash,
	workflowJournalSeed,
} from './resume.js'
import type {
	CheckedWorkflowJournal,
	WorkflowJournal,
	WorkflowJournalReader,
	WorkflowJournalRecord,
} from './types.js'

export function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

/** The first `max` UTF-16 units of `text`, never ending inside a surrogate pair. */
export function preview(text: string, max = 500): string {
	if (text.length <= max) return text
	let end = max
	const last = text.charCodeAt(end - 1)
	if (last >= 0xd800 && last <= 0xdbff) end--
	return `${text.slice(0, end)}…`
}

/** The chain state of one journal file, shared by every writer in this process. */
interface ChainState {
	queue: Promise<void>
	loaded: boolean
	seq: number
	prev: string
	needsNewline: boolean
	finished: boolean
	/** Bytes the file had after the last write this process made; a different size means someone else wrote. */
	size: number
}

const chains = new Map<string, ChainState>()

/** Records after which a crash must not lose the line: a saved result, the end of a pass, the start of one. */
function mustSurviveCrash(record: WorkflowJournalRecord): boolean {
	return (
		record.type === 'run_finished' ||
		record.type === 'run_started' ||
		(record.type === 'agent_outcome' && Object.hasOwn(record, 'result'))
	)
}

/**
 * A journal in a directory: `script.js` (the exact script text, mode 0600)
 * and `journal.jsonl` (one JSON record per line, append-only). The caller
 * chooses the directory, normally `<session>/runs/<runId>/workflow/`.
 *
 * Every line carries `seq` and `prev` (the hash of the line before it, the
 * first chaining from a seed bound to the run id), so a line that was edited,
 * removed or cut short is found when the journal is read back. One writer per
 * file serves the whole process: a resumed pass and a late agent of the pass
 * before it append through the same queue and the same chain, and nothing is
 * appended after a pass's `run_finished` until the next pass starts. This
 * assumes one process writes the file at a time, which the session lease
 * already guarantees. A chain proves the file was not damaged or edited by
 * accident; someone who can rewrite the whole file can rewrite the chain too.
 */
export class FileWorkflowJournal implements WorkflowJournal, WorkflowJournalReader {
	private ready: Promise<void> | undefined
	private readonly file: string

	constructor(
		private readonly dir: string,
		private readonly options: {
			readonly runId?: string
			/** A secret that signs every line; see `readWorkflowJournalChecked`. */
			readonly key?: string | Uint8Array
		} = {},
	) {
		this.file = resolve(dir, 'journal.jsonl')
	}

	private ensure(): Promise<void> {
		this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => undefined)
		return this.ready
	}

	private runId(record?: WorkflowJournalRecord): string {
		if (this.options.runId !== undefined) return this.options.runId
		if (record?.type === 'run_started') return record.runId
		return basename(dirname(resolve(this.dir)))
	}

	async writeScript(source: string, _sha256?: string, pass = 1): Promise<void> {
		await this.ensure()
		const name = pass <= 1 ? 'script.js' : `script.${pass}.js`
		await writeFile(join(this.dir, name), source, { mode: 0o600 })
	}

	async read(): Promise<CheckedWorkflowJournal> {
		let text: string
		try {
			text = await readFile(this.file, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			text = ''
		}
		return readWorkflowJournalChecked(text, this.runId(), {
			...(this.options.key !== undefined ? { key: this.options.key } : {}),
		})
	}

	append(record: WorkflowJournalRecord): Promise<void> {
		let state = chains.get(this.file)
		if (state === undefined) {
			state = {
				queue: Promise.resolve(),
				loaded: false,
				seq: 0,
				prev: '',
				needsNewline: false,
				finished: false,
				size: 0,
			}
			chains.set(this.file, state)
		}
		const chain = state
		const run = chain.queue.then(async () => {
			await this.ensure()
			const onDisk = await stat(this.file).then(
				(info) => info.size,
				() => 0,
			)
			if (!chain.loaded || onDisk !== chain.size) {
				const checked = await this.read()
				chain.seq = checked.lastSeq
				chain.prev = checked.lastHash
				chain.needsNewline = !checked.endsWithNewline
				chain.finished = checked.records.at(-1)?.type === 'run_finished'
				chain.loaded = true
				chain.size = onDisk
			}
			if (record.type === 'run_started') chain.finished = false
			// Nothing belongs after the pass's end; a late agent of that pass is dropped here.
			else if (chain.finished) return
			if (chain.seq === 0) chain.prev = workflowJournalSeed(this.runId(record))
			const seq = chain.seq + 1
			const line = formatWorkflowJournalLine(record, seq, chain.prev, this.options.key)
			const handle = await open(this.file, 'a', 0o600)
			try {
				const text = `${chain.needsNewline ? '\n' : ''}${line}\n`
				await handle.appendFile(text)
				chain.size += Buffer.byteLength(text)
				if (mustSurviveCrash(record)) await handle.datasync()
			} finally {
				await handle.close()
			}
			chain.needsNewline = false
			chain.seq = seq
			chain.prev = workflowJournalLineHash(line)
			if (record.type === 'run_finished') chain.finished = true
		})
		chain.queue = run.catch(() => undefined)
		return run
	}
}

import { createHash } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { WorkflowJournal, WorkflowJournalRecord } from './types.js'

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

/**
 * A journal in a directory: `script.js` (the exact script text, mode 0600)
 * and `journal.jsonl` (one JSON record per line, append-only). The caller
 * chooses the directory, normally `<session>/runs/<runId>/workflow/`.
 */
export class FileWorkflowJournal implements WorkflowJournal {
	private ready: Promise<void> | undefined

	constructor(private readonly dir: string) {}

	private ensure(): Promise<void> {
		this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => undefined)
		return this.ready
	}

	async writeScript(source: string): Promise<void> {
		await this.ensure()
		await writeFile(join(this.dir, 'script.js'), source, { mode: 0o600 })
	}

	async append(record: WorkflowJournalRecord): Promise<void> {
		await this.ensure()
		await appendFile(join(this.dir, 'journal.jsonl'), `${JSON.stringify(record)}\n`, {
			mode: 0o600,
		})
	}
}

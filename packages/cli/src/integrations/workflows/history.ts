/**
 * Runs from the journals under `<session>/runs/<runId>/workflow/`: what
 * `/workflows` lists for runs this process no longer holds.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { WorkflowJournalRecord } from '@namzu/sdk'

import { type WorkflowRunView, viewFromJournal } from './view.js'

const RUN_ID = /^w[0-9a-z]{8}$/

/** The records of one journal; a line that is not a record is skipped, a missing file is no records. */
export async function readWorkflowJournal(file: string): Promise<readonly WorkflowJournalRecord[]> {
	let text: string
	try {
		text = await readFile(file, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
	const records: WorkflowJournalRecord[] = []
	for (const line of text.split('\n')) {
		if (line.trim().length === 0) continue
		try {
			const parsed = JSON.parse(line) as unknown
			if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
				records.push(parsed as WorkflowJournalRecord)
			}
		} catch {
			// A torn last line is what a crash leaves; the records before it stand.
		}
	}
	return records
}

/** One run from its journal, or `undefined` when the journal does not exist or has no start. */
export async function readWorkflowRun(
	runsDirectory: string,
	runId: string,
): Promise<WorkflowRunView | undefined> {
	if (!RUN_ID.test(runId)) return undefined
	const records = await readWorkflowJournal(join(runsDirectory, runId, 'workflow', 'journal.jsonl'))
	return viewFromJournal(records)
}

/** Every journaled run of the session, newest first. */
export async function listWorkflowRuns(runsDirectory: string): Promise<readonly WorkflowRunView[]> {
	let entries: string[]
	try {
		entries = await readdir(runsDirectory)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
	const views = await Promise.all(
		entries.filter((name) => RUN_ID.test(name)).map((name) => readWorkflowRun(runsDirectory, name)),
	)
	return views
		.filter((view): view is WorkflowRunView => view !== undefined)
		.sort((a, b) => b.startedAt - a.startedAt)
}

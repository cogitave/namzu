/**
 * Runs whose process ended before they finished, found when a conversation is
 * opened again. Nothing resumes by itself: the model is told once, in words it
 * can act on, and the run is marked stopped so it is not announced again.
 *
 * The notice is kept on disk beside the journal (`orphan-notice.json`) before
 * the run is marked, and stays there until a turn has delivered it. Quitting
 * before a model turn reads it therefore does not lose it, and a mark that
 * cannot be written does not repeat it.
 */

import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
	FileWorkflowJournal,
	type WorkflowJournalRecord,
	type WorkflowUsage,
	loadWorkflowResume,
} from '@namzu/sdk'

import { RUN_ID_PATTERN, editableCopyPath, resumeCallText } from './resume.js'

const NOTICE_FILE = 'orphan-notice.json'
/** More unfinished runs than this are announced as one message. */
export const MAX_ORPHAN_NOTICES = 20

export interface OrphanNotice {
	readonly runId: string
	/** Every run this notice covers (more than one for the aggregate). */
	readonly runIds: readonly string[]
	readonly name: string
	/** What the model is told. */
	readonly text: string
	/** The one line the operator sees in the conversation. */
	readonly line: string
}

interface StoredNotice {
	readonly runId: string
	readonly name: string
	readonly text: string
	readonly line: string
	readonly delivered: boolean
	readonly at: number
}

const NO_USAGE: WorkflowUsage = {
	agents: 0,
	agentsDone: 0,
	agentsFailed: 0,
	agentsSkipped: 0,
	tokens: 0,
	toolCalls: 0,
	elapsedMs: 0,
}

/** A name from a script, made safe to quote to the model: one line, no control characters. */
function quotedName(name: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping exactly these
	const plain = name
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return JSON.stringify(plain.length > 80 ? `${plain.slice(0, 80)}…` : plain)
}

function noticePath(runsDirectory: string, runId: string): string {
	return join(runsDirectory, runId, 'workflow', NOTICE_FILE)
}

async function readStored(runsDirectory: string, runId: string): Promise<StoredNotice | undefined> {
	try {
		const parsed = JSON.parse(await readFile(noticePath(runsDirectory, runId), 'utf8')) as unknown
		if (typeof parsed !== 'object' || parsed === null) return undefined
		const stored = parsed as Partial<StoredNotice>
		if (
			typeof stored.text === 'string' &&
			typeof stored.line === 'string' &&
			typeof stored.name === 'string' &&
			typeof stored.delivered === 'boolean'
		) {
			return stored as StoredNotice
		}
	} catch {
		// No notice yet, or one that cannot be read: the run is judged from its journal.
	}
	return undefined
}

function words(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Find the runs of this conversation that no process is running and that never
 * recorded an end. Each is marked stopped and returned once; later calls
 * return only notices that were stored and not yet delivered.
 */
export async function recoverUnfinishedWorkflows(options: {
	readonly runsDirectory: string
	readonly liveRunIds: ReadonlySet<string>
	readonly key?: string
	readonly now?: () => number
}): Promise<readonly OrphanNotice[]> {
	const now = options.now ?? Date.now
	let entries: string[]
	try {
		entries = await readdir(options.runsDirectory)
	} catch {
		return []
	}
	const found: StoredNotice[] = []
	for (const runId of entries.filter((name) => RUN_ID_PATTERN.test(name)).sort()) {
		if (options.liveRunIds.has(runId)) continue
		const stored = await readStored(options.runsDirectory, runId)
		if (stored) {
			if (!stored.delivered) found.push(stored)
			continue
		}
		const dir = join(options.runsDirectory, runId, 'workflow')
		const journal = new FileWorkflowJournal(dir, {
			runId,
			...(options.key !== undefined ? { key: options.key } : {}),
		})
		let checked: Awaited<ReturnType<FileWorkflowJournal['read']>>
		try {
			checked = await journal.read()
		} catch {
			continue
		}
		const records: readonly WorkflowJournalRecord[] = checked.legacy
			? checked.untrusted
			: checked.records
		const startedAt = records.map((record) => record.type).lastIndexOf('run_started')
		if (startedAt < 0) continue
		if (records.slice(startedAt).some((record) => record.type === 'run_finished')) continue
		const started = records[startedAt]
		if (started?.type !== 'run_started') continue
		const name = started.meta.name
		let text: string
		if (checked.legacy) {
			text = `Background workflow ${quotedName(name)} (run ${runId}) didn't finish before the previous session ended. It was saved before resuming was possible, so it cannot be resumed. Run it again from the start.`
		} else {
			const state = loadWorkflowResume(checked)
			const unfinished = [...state.seen].filter(
				(key) => !state.results.has(key) && !state.failed.has(key),
			).length
			const copy = editableCopyPath(options.runsDirectory, name, runId)
			const script = started.scriptPath ?? (existsSync(copy) ? copy : undefined)
			text = [
				`Background workflow ${quotedName(name)} (run ${runId}) didn't finish before the previous session ended.`,
				`No finish record was found for it, so the process most likely exited while it ran. ${words(state.results.size, 'agent')} had finished and saved their results; ${unfinished} had started and not finished.`,
				`To pick up where it left off, call ${resumeCallText(script, runId)}; agents whose prompt and options are unchanged return their saved results without running again. You may edit the script file first. Nothing resumes by itself.`,
				...(checked.brokenAt !== undefined
					? [
							`The journal of workflow ${runId} was changed or cut short at line ${checked.brokenAt}. Results after that point are not trusted and those agents will run again.`,
						]
					: []),
			].join('\n')
		}
		const notice: StoredNotice = {
			runId,
			name,
			text,
			line: `${name} didn't finish before the last session ended. /workflows to see it or resume it.`,
			delivered: false,
			at: now(),
		}
		// The notice is stored first: once it is on disk the run is announced exactly once,
		// whether or not the mark below can be written.
		try {
			await writeFile(noticePath(options.runsDirectory, runId), JSON.stringify(notice), {
				mode: 0o600,
				flag: 'wx',
			})
		} catch {
			continue
		}
		if (!checked.legacy) {
			await journal
				.append({
					type: 'run_finished',
					at: now(),
					status: 'stopped',
					error: 'The session ended before this workflow finished.',
					usage: NO_USAGE,
					recovered: true,
				})
				.catch(() => undefined)
		}
		found.push(notice)
	}
	if (found.length <= MAX_ORPHAN_NOTICES) {
		return found.map(({ runId, name, text, line }) => ({
			runId,
			runIds: [runId],
			name,
			text,
			line,
		}))
	}
	const ids = found.slice(0, MAX_ORPHAN_NOTICES).map((notice) => notice.runId)
	return [
		{
			runId: found[0]?.runId ?? '',
			runIds: found.map((notice) => notice.runId),
			name: 'workflows',
			text: `${found.length} background workflows didn't finish before the previous session ended. Run ids: ${ids.join(', ')}. No finish record was found for them. They have been marked stopped. Ask for one by name to resume it.`,
			line: `${found.length} workflows didn't finish before the last session ended. /workflows to see them.`,
		},
	]
}

/** Record that a turn has handed the notice for these runs to the model. */
export async function markOrphanNoticesDelivered(
	runsDirectory: string,
	runIds: readonly string[],
): Promise<void> {
	for (const runId of runIds) {
		const stored = await readStored(runsDirectory, runId)
		if (!stored || stored.delivered) continue
		await writeFile(
			noticePath(runsDirectory, runId),
			JSON.stringify({ ...stored, delivered: true }),
			{
				mode: 0o600,
			},
		).catch(() => undefined)
	}
}

/**
 * The one-time pass over records the runtime derived before the screen
 * existed. A record the screen would not write today (a raw request as its
 * title, a verbatim user message, a search trace, a raw error, a secret, an
 * injected instruction) is archived: kept on disk with `status: archived`,
 * out of recall and out of `/memory`, never deleted. Records an operator or
 * the model chose to save are never read here.
 *
 * Done once per memory directory, recorded by an empty marker file next to
 * the records. A store failure ends the pass quietly without the marker, so
 * the next session tries again; nothing here can stop a session starting.
 */

import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
	type Logger,
	type MarkdownMemoryStore,
	MemoryRevisionConflictError,
	SESSION_MEMORY_TAG,
	memoryOrigin,
} from '@namzu/sdk'

import { contentReason, screenCandidate } from './screen.js'

/** Marker file name; bump the suffix when the screen's rules change. */
export const SCREEN_MARKER_FILE = '.derived-screen-v1'

type Candidate = Parameters<typeof screenCandidate>[0]

const HEADINGS: Readonly<
	Record<string, 'userRequirements' | 'decisions' | 'discoveries' | 'failures' | 'environment'>
> = {
	'What the user requires': 'userRequirements',
	Decisions: 'decisions',
	Discoveries: 'discoveries',
	'What did not work': 'failures',
	Environment: 'environment',
}

/** Read the sections the promoter rendered back into a candidate. */
function parseRecord(title: string, body: string): Candidate {
	const lists: Record<string, string[]> = {
		userRequirements: [],
		decisions: [],
		discoveries: [],
		failures: [],
		environment: [],
	}
	let current: string | undefined
	const files: string[] = []
	for (const line of body.split('\n')) {
		const heading = /^##\s+(.*?)\s*$/.exec(line)
		if (heading) {
			const name = heading[1] ?? ''
			current = name === 'Files touched' ? 'files' : HEADINGS[name]
			continue
		}
		const item = /^-\s+(.*)$/.exec(line)
		if (!item || current === undefined) continue
		if (current === 'files') files.push(item[1] ?? '')
		else lists[current]?.push(item[1] ?? '')
	}
	return {
		sessionId: '' as never,
		turnId: '' as never,
		task: title,
		decisions: lists.decisions ?? [],
		discoveries: lists.discoveries ?? [],
		userRequirements: lists.userRequirements ?? [],
		failures: lists.failures ?? [],
		environment: lists.environment ?? [],
		files,
		evicted: {},
	}
}

function wouldNotBeWritten(
	title: string,
	body: string,
	metadata: Readonly<Record<string, unknown>> | undefined,
): boolean {
	if (contentReason(`${title}\n${body}`) !== undefined) return true
	// A consolidation quotes the first request as `Learned: <task>` and `Task: <task>`
	// and carries failures verbatim; it has no claim sections to re-read.
	if (
		metadata?.kind === 'consolidation' ||
		title.startsWith('Learned') ||
		/^\s*Task:/m.test(body)
	) {
		return true
	}
	if (metadata?.source !== SESSION_MEMORY_TAG) return false
	// A title that is not the neutral one is the first request, quoted.
	if (!title.startsWith('Session notes')) return true
	const { dropped } = screenCandidate(parseRecord(title, body))
	return Object.keys(dropped).length > 0
}

export interface ArchiveReport {
	readonly ran: boolean
	readonly archived: number
	readonly skipped: number
}

export async function archiveUnscreenedRecords(options: {
	readonly store: MarkdownMemoryStore
	readonly directory: string
	readonly log: Logger
}): Promise<ArchiveReport> {
	const { store, directory, log } = options
	const marker = join(directory, SCREEN_MARKER_FILE)
	try {
		if (
			await access(marker).then(
				() => true,
				() => false,
			)
		) {
			return { ran: false, archived: 0, skipped: 0 }
		}
		const { entries } = await store.list({ status: 'active' })
		let archived = 0
		let skipped = 0
		for (const entry of entries) {
			try {
				const record = await store.getVersionedRecord(entry.id)
				if (!record || record.entry.status !== 'active') continue
				const metadata = record.content.metadata
				if (memoryOrigin(metadata) !== 'derived') continue
				if (!wouldNotBeWritten(record.entry.title, record.content.content, metadata)) continue
				await store.updateIfRevision(entry.id, { status: 'archived' }, record.revision)
				archived += 1
				log.info('memory record archived', {
					'namzu.memory.screen.reason': 'unscreened_derived',
					'namzu.memory.screen.archived_count': 1,
				})
			} catch (error) {
				if (!(error instanceof MemoryRevisionConflictError)) throw error
				skipped += 1
			}
		}
		await writeFile(marker, '', { flag: 'w' })
		log.info('memory screen pass finished', {
			'namzu.memory.screen.archived_count': archived,
			'namzu.memory.screen.skipped_count': skipped,
		})
		return { ran: true, archived, skipped }
	} catch (error) {
		log.warn('memory screen pass failed', {
			'namzu.memory.screen.error': error instanceof Error ? error.name : 'unknown',
		})
		return { ran: false, archived: 0, skipped: 0 }
	}
}

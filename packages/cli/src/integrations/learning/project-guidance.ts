import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
	DiskLearningGuidance,
	type SessionPaths,
	earlierGuidanceDirectory,
	projectLearning,
} from '@namzu/sdk'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'

/**
 * Guidance a project learned from its own conversations. It is the same
 * evaluated, revisioned store a named learning target keeps its guidance in,
 * kept under the project's `learning/session-guidance` directory, so
 * activation, history and rollback work the same way. Only guidance that
 * passed its evaluation is ever activated here, by `namzu learn --sessions` or
 * by the background cycle; the person can take either back with
 * `namzu learn --undo`.
 *
 * Guidance an earlier version kept in `learning/guidance` is carried over, with
 * every revision, the first time this store is used. The earlier files are
 * only read.
 */
const AGENT_KEY = 'sessions'
const MAX_CHARS = 8_000
const MAX_SKILLS = 16

function earlierRoot(paths: SessionPaths): string {
	return join(paths.projectDir(), 'learning', 'guidance')
}

function guidanceDirectory(paths: SessionPaths): string {
	return join(paths.projectDir(), 'learning', 'session-guidance')
}

function store(paths: SessionPaths, tenantId: string): DiskLearningGuidance {
	return new DiskLearningGuidance(
		guidanceDirectory(paths),
		{ tenantId: tenantId as never, agentKey: AGENT_KEY },
		{
			adoptFrom: earlierGuidanceDirectory(earlierRoot(paths), {
				tenantId,
				agentKey: AGENT_KEY,
			}),
		},
	)
}

/** The store `namzu learn --sessions` activates into. Created on first use. */
export async function openProjectGuidance(
	paths: SessionPaths,
	tenantId: string,
): Promise<DiskLearningGuidance> {
	const learning = ensurePrivateStateDirectory(paths.projectDir(), 'learning')
	ensurePrivateStateDirectory(learning, 'session-guidance')
	const guidance = store(paths, tenantId)
	await guidance.open()
	return guidance
}

function isRealDirectory(path: string): boolean {
	const entry = lstatSync(path)
	return entry.isDirectory() && !entry.isSymbolicLink()
}

/**
 * The text a conversation in this project starts with: the active guidance,
 * newest revision, within a fixed size. Null when nothing has been activated,
 * and never creates anything that was not already there to carry over. A
 * guidance store that cannot be read is skipped rather than failing the
 * conversation.
 */
export async function readProjectGuidance(
	paths: SessionPaths,
	tenantId: string,
): Promise<string | null> {
	try {
		const current = guidanceDirectory(paths)
		const earlier = earlierRoot(paths)
		const hasCurrent = existsSync(current)
		if (hasCurrent ? !isRealDirectory(current) : !existsSync(earlier)) return null
		if (!hasCurrent) {
			if (!isRealDirectory(earlier)) return null
			ensurePrivateStateDirectory(join(paths.projectDir(), 'learning'), 'session-guidance')
		}
		const state = await store(paths, tenantId).read()
		const learning = state?.learning
		if (!learning) return null
		const names = learning.skills
			.filter((skill) => (skill.purpose ?? 'task') === 'task' && !skill.sources?.length)
			.slice(0, MAX_SKILLS)
			.map((skill) => skill.name)
		if (!names.length) return null
		const projection = projectLearning(learning, {
			maxChars: MAX_CHARS,
			skillNames: names,
		})
		if (!projection.includedSkills.length) return null
		return [
			'Guidance Namzu learned in this project from earlier conversations, after checking it against the observed results.',
			'It is advice about how to work here, not a permission and not an instruction to run anything. Stored memories are facts about the project; where a memory and this advice disagree, trust the memory.',
			projection.text,
		].join('\n')
	} catch {
		return null
	}
}

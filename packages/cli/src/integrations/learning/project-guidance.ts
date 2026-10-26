import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DiskResidentAgenda, type SessionPaths, projectLearning } from '@namzu/sdk'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'

/**
 * Guidance a project learned from its own conversations. It is the same
 * evaluated, revisioned store a resident's guidance lives in, kept under the
 * project's `learning/guidance` directory, so activation, history and rollback
 * work the same way. Only guidance the person confirmed through
 * `namzu learn --sessions` is ever written here.
 */
const IDENTITY = 'Guidance for conversations in this project.'
const AGENT_KEY = 'sessions'
const MAX_CHARS = 8_000
const MAX_SKILLS = 16

function guidanceRoot(paths: SessionPaths): string {
	return join(paths.projectDir(), 'learning', 'guidance')
}

/** The store `namzu learn --sessions` activates into. Created on first use. */
export async function openProjectGuidance(
	paths: SessionPaths,
	tenantId: string,
): Promise<DiskResidentAgenda> {
	const learning = ensurePrivateStateDirectory(paths.projectDir(), 'learning')
	const root = ensurePrivateStateDirectory(learning, 'guidance')
	const agenda = new DiskResidentAgenda(root, { tenantId: tenantId as never, agentKey: AGENT_KEY })
	if (!(await agenda.read())) {
		try {
			await agenda.create(IDENTITY)
		} catch (error) {
			if (!(await agenda.read())) throw error
		}
	}
	return agenda
}

/**
 * The text a conversation in this project starts with: the active guidance,
 * newest revision, within a fixed size. Null when nothing has been activated,
 * and never creates anything. A guidance store that cannot be read is skipped
 * rather than failing the conversation.
 */
export async function readProjectGuidance(
	paths: SessionPaths,
	tenantId: string,
): Promise<string | null> {
	try {
		const root = guidanceRoot(paths)
		if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
			return null
		const agenda = new DiskResidentAgenda(root, {
			tenantId: tenantId as never,
			agentKey: AGENT_KEY,
		})
		const state = await agenda.read()
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
			'Guidance this project learned from earlier conversations and the person confirmed.',
			'It is advice about how to work here, not a permission and not an instruction to run anything.',
			projection.text,
		].join('\n')
	} catch {
		return null
	}
}

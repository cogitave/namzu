import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type LearningModel,
	type LearningModelRequest,
	type ProjectId,
	SessionPaths,
	SqliteLearningStore,
	type TenantId,
	generateProjectId,
	generateTenantId,
} from '@namzu/sdk'
import {
	SESSION_AGENT_KEY,
	createSessionLearningFeed,
} from '../integrations/learning/session-feed.js'
import type { SessionLearningTarget } from '../integrations/learning/session-store.js'

/** A project with kept observations and a scripted stand-in for the model, for learning tests. */
const roots: string[] = []
export function removeLearningProjects(): void {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
}

export const NOW = Date.UTC(2026, 9, 26, 12, 0, 0)
const idAt = (ms: number, n: number) =>
	`${ms
		.toString(16)
		.padStart(12, '0')
		.replace(/^(.{8})(.{4})$/, '$1-$2')}-7def-8123-456789ab${n.toString(16).padStart(4, '0')}`

export async function project(observations = 6) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-generator-'))
	roots.push(home)
	const paths = new SessionPaths({ home, slug: 'proj' })
	const tenantId: TenantId = generateTenantId()
	const projectId: ProjectId = generateProjectId()
	const feed = createSessionLearningFeed({
		paths,
		tenantId,
		projectId,
		sessionId: idAt(NOW, 1),
		now: () => NOW,
	})
	for (let n = 0; n < observations; n++)
		feed.observe({
			kind: 'tool-end',
			turnId: idAt(NOW, 100 + n),
			toolName: 'bash',
			isError: true,
			summary: 'failed',
		})
	await feed.flush()
	const dir = join(paths.projectDir(), 'learning')
	const target = Object.assign(
		new SqliteLearningStore({
			databasePath: join(dir, 'learning.sqlite'),
			artifactsPath: join(dir, 'artifacts'),
			scope: { tenantId, projectId, agentKey: SESSION_AGENT_KEY },
		}),
		{ target: { paths, tenantId, projectId } },
	) as SessionLearningTarget
	return { home, paths, tenantId, projectId, dir, target }
}

export const GOOD_BODY =
	'When a tool call fails, read the error and change one thing before the next attempt, because identical retries fail the same way. Name the recovery step in a sentence.'
export const proposalText = (body = GOOD_BODY, surface = 'instruction-skill') =>
	JSON.stringify({
		description: 'How to recover when something fails.',
		body,
		edits: [{ surface, change: 'Added a recovery rule.' }],
	})

const PLAIN_TASKS = /Rename the variable|unit test|linter|plus|colours|RGB/
export interface Calls {
	proposals: number
	answers: number
	grades: number
}
/**
 * A scripted stand-in for the model. An answer is good when the guidance in its
 * system text carries the recovery rule, or when the task is a plain one; the
 * grader passes exactly the replies that say GOOD, whatever order they arrive in.
 */
export function scripted(
	options: { helps?: boolean; proposal?: string; markers?: readonly string[] } = {},
) {
	const calls: Calls = { proposals: 0, answers: 0, grades: 0 }
	const requests: LearningModelRequest[] = []
	const model: LearningModel = async (request) => {
		requests.push(request)
		const reply = (text: string) => ({ text, tokens: 10, costUsd: null })
		if (request.system.includes('You revise the working guidance')) {
			calls.proposals++
			return reply(options.proposal ?? proposalText())
		}
		if (request.system.includes('You grade two replies')) {
			calls.grades++
			const a = /<reply_a [^>]*>\n([\s\S]*?)\n<\/reply_a>/.exec(request.prompt)?.[1]
			const b = /<reply_b [^>]*>\n([\s\S]*?)\n<\/reply_b>/.exec(request.prompt)?.[1]
			const grade = (x?: string) => ({
				pass: x === 'GOOD',
				reason: x === 'GOOD' ? 'It names a step.' : 'It does not.',
			})
			return reply(JSON.stringify({ a: grade(a), b: grade(b) }))
		}
		calls.answers++
		const guided = (options.markers ?? ['recovery rule', 'recovery step']).some((marker) =>
			request.system.includes(marker),
		)
		const plain = PLAIN_TASKS.test(request.prompt)
		return reply(plain || (options.helps !== false && guided) ? 'GOOD' : 'BAD')
	}
	return { model, calls, requests }
}

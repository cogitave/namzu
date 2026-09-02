/**
 * The working doctrine, the turn-start repository snapshot and the active
 * task tools reach the turn that is supposed to use them.
 *
 * Three separate hops, each of which can be dropped one function short of
 * the provider while every unit test one layer down stays green:
 *
 *   doctrine.ts       → system prompt of the parent turn
 *                     → system prompt of every delegated sub-agent
 *   turn-snapshot.ts  → `promptContributions` handed to query(), rendered
 *                       on iteration 1 and on no other
 *   runtimeToolOverrides → the task tools register `active`, not `deferred`
 *
 * The repository here is a real one with a commit subject and an untracked
 * file that only this test could have produced, so a passing assertion is
 * evidence that `git` was actually asked rather than that a fixture string
 * came back.
 *
 * What this file does NOT prove, because `query` is replaced: that the SDK
 * puts a `turn` contribution into the request on the iteration it names.
 * That hop is the SDK's contract and has its own process-level test,
 * `packages/sdk/src/prompt/__tests__/state-that-changes-during-a-run.proc-test.ts`.
 * Here the registry is rendered directly, which proves the CLI registered the
 * right text under the right placement and iteration — the half only the CLI
 * can get wrong.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { type AgentDefinition, AgentRegistry, type Message } from '@namzu/sdk'
import type { PromptContributionRegistry } from '@namzu/sdk'

import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let root: string
let repo: string

beforeEach(() => {
	queryCalls.length = 0
	root = mkdtempSync(join(tmpdir(), 'namzu-doctrine-'))
	repo = join(root, 'repo')
	mkdirSync(repo, { recursive: true })
	execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repo })
	execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo })
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
})

afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(root)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

function detectedAnthropic(): DetectedProvider[] {
	return [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				defaultModel: 'claude-sonnet-4-5',
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: 'env',
			apiKey: 'sk-ant-not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
}

async function openSessionIn(cwd: string) {
	const { createAgentSession } = await import('../tui/agent.js')
	return createAgentSession(prefs, detectedAnthropic(), { cwd })
}

async function drive(cwd: string): Promise<Record<string, unknown>> {
	const session = await openSessionIn(cwd)
	const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
	for await (const _ of session.send(messages)) {
		// drain
	}
	expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
	return queryCalls[0] as Record<string, unknown>
}

function commit(cwd: string, subject: string): void {
	writeFileSync(join(cwd, 'tracked.txt'), `${subject}\n`)
	execFileSync('git', ['add', 'tracked.txt'], { cwd })
	execFileSync('git', ['commit', '--quiet', '-m', subject], { cwd })
}

/**
 * One sentence from each section, so the assertion fails when a section is
 * dropped rather than only when the heading is. A test that checked the
 * heading alone would survive the doctrine being reduced to its heading.
 */
const DOCTRINE_SENTENCES = [
	'The requested scope is the deliverable.',
	'If tests fail, say so and show the output.',
	'Read a file before you edit it',
	'Never push, force-push, reset, rebase, clean',
	'Before a batch of tool calls, say in one short line',
]

const DELEGATION_SENTENCES = [
	'open a task list with `task_create`',
	'When the `Agent` tool is available',
]

async function subagentSystemPrompt(): Promise<string> {
	const registered: AgentDefinition[] = []
	vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation((def) => {
		for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
	})

	await openSessionIn(repo)

	const general = registered.find((d) => d.info.id === 'general-purpose')
	if (!general?.configBuilder) {
		throw new Error('the sub-agent runtime did not stand up — this test proves nothing')
	}
	const config = (await general.configBuilder({})) as { systemPrompt?: string }
	return config.systemPrompt ?? ''
}

describe('the working doctrine', () => {
	it('is in the system prompt the parent turn is run with, after the identity block', async () => {
		const call = await drive(repo)
		const systemPrompt = String(call.systemPrompt ?? '')

		for (const sentence of [...DOCTRINE_SENTENCES, ...DELEGATION_SENTENCES]) {
			expect(systemPrompt).toContain(sentence)
		}
		expect(
			systemPrompt.indexOf('You are namzu'),
			'identity first, then how to work — the model weights early text more',
		).toBeLessThan(systemPrompt.indexOf('## How you work'))
	})

	it('reaches every delegated sub-agent, not only the parent', async () => {
		const prompt = await subagentSystemPrompt()

		for (const sentence of DOCTRINE_SENTENCES) {
			expect(prompt).toContain(sentence)
		}
	})

	it('does not tell a sub-agent to use the tools only the parent has', async () => {
		// A sub-agent's registry comes from `buildToolRegistry` with no task
		// store and no `Agent` tool. A rule naming either is, for that reader,
		// an instruction to fail — which is what the first draft shipped.
		const prompt = await subagentSystemPrompt()

		for (const sentence of DELEGATION_SENTENCES) {
			expect(prompt).not.toContain(sentence)
		}
		expect(prompt).not.toContain('task_create')
	})
})

describe('the turn-start snapshot', () => {
	it('carries the real working tree and recent commits, on the first iteration only', async () => {
		const subject = `feat: snapshot-sentinel-${process.pid}`
		commit(repo, subject)
		const scratch = `scratch-${process.pid}.txt`
		writeFileSync(join(repo, scratch), 'untracked\n')

		const call = await drive(repo)
		const contributions = call.promptContributions as PromptContributionRegistry | undefined
		if (!contributions) throw new Error('query() did not receive the prompt contributions')

		const first = contributions.render('turn', { iteration: 1 }).join('\n')
		expect(first, 'the untracked file only `git status` could have named').toContain(
			`?? ${scratch}`,
		)
		expect(first, 'the commit subject only `git log` could have produced').toContain(subject)
		expect(
			first,
			'names and subjects are text somebody wrote, landing in a system message',
		).toContain('<namzu-untrusted kind="repository-snapshot"')

		expect(
			contributions.render('turn', { iteration: 2 }),
			'a later iteration works from state the model changed itself',
		).toEqual([])
	})

	it('is not in the cached system prompt', async () => {
		writeFileSync(join(repo, `dirty-${process.pid}.txt`), 'x\n')

		const call = await drive(repo)

		expect(String(call.systemPrompt ?? '')).not.toContain(`dirty-${process.pid}.txt`)
	})

	it('renders nothing outside a repository rather than an empty heading', async () => {
		const plain = join(root, 'plain')
		mkdirSync(plain)

		const call = await drive(plain)
		const contributions = call.promptContributions as PromptContributionRegistry

		expect(contributions.render('turn', { iteration: 1 })).toEqual([])
	})
})

describe('the task tools', () => {
	it('register active, so a plan does not cost a search_tools round-trip first', async () => {
		const call = await drive(repo)

		expect(call.runtimeToolOverrides).toEqual({
			task_create: 'active',
			task_update: 'active',
			task_list: 'active',
		})
	})
})

/**
 * The working doctrine, the recorded repository snapshot and the active
 * task tools reach the turn that is supposed to use them.
 *
 * Three separate hops, each of which can be dropped one function short of
 * the provider while every unit test one layer down stays green:
 *
 *   doctrine.ts       → system prompt of the parent turn
 *                     → system prompt of every delegated sub-agent
 *   turn-snapshot.ts  → a `prepareStep` stage handed to query(), recording the
 *                       repository once and again only when it changes
 *   runtimeToolOverrides → the task tools register `active`, not `deferred`
 *
 * The repository here is a real one with a commit subject and an untracked
 * file that only this test could have produced, so a passing assertion is
 * evidence that `git` was actually asked rather than that a fixture string
 * came back.
 *
 * What this file does NOT prove, because `query` is replaced: that the SDK
 * appends a step's recorded context to the history. That hop is the SDK's
 * contract and has its own test, which drives the real query loop:
 * `packages/sdk/src/runtime/query/__tests__/turn-context-entries.test.ts`.
 * Here the stage is run directly, which proves the CLI registered a stage that
 * records the real repository under the right key — the half only the CLI can
 * get wrong.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import {
	type AgentDefinition,
	AgentRegistry,
	type Message,
	type PrepareStep,
	createTurnContextEntry,
} from '@namzu/sdk'

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
	return createAgentSession(prefs, detectedAnthropic(), { cwd, web: { search: 'off' } })
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
	'The requested scope is the deliverable:',
	'If tests fail, say so and show the output.',
	'Before editing, use the relevant file content already available from a successful read or write',
	'Never push, force-push, reset, rebase, clean',
	'Before your first tool call, say in one short line',
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
			systemPrompt.indexOf('You are Namzu'),
			'identity first, then how to work — the model weights early text more',
		).toBeLessThan(systemPrompt.indexOf('## How you work'))
	})

	it('reaches every delegated sub-agent, not only the parent', async () => {
		const prompt = await subagentSystemPrompt()

		// Every working rule but the one about narrating to the person: a
		// sub-agent reports to its parent, and says so in its own section.
		for (const sentence of DOCTRINE_SENTENCES.filter(
			(s) => !s.startsWith('Before your first tool call'),
		)) {
			expect(prompt).toContain(sentence)
		}
		expect(prompt).not.toContain('Before your first tool call')
		expect(prompt).toContain('### Your final report')
	})

	it('does not tell a sub-agent to use the tools only the parent has', async () => {
		// A sub-agent's registry comes from the same base toolsets, without a task
		// store and no `Agent` tool. A rule naming either is, for that reader,
		// an instruction to fail — which is what the first draft shipped.
		const prompt = await subagentSystemPrompt()

		for (const sentence of DELEGATION_SENTENCES) {
			expect(prompt).not.toContain(sentence)
		}
		expect(prompt).not.toContain('task_create')
	})
})

describe('the recorded repository snapshot', () => {
	/** Run every stage the turn was given; the repository stage is the one that records. */
	async function recorded(
		call: Record<string, unknown>,
		messages: Message[],
	): Promise<{ key: string; text: string }[]> {
		const stages = [call.prepareStep].flat() as PrepareStep[]
		const items: { key: string; text: string }[] = []
		for (const stage of stages) {
			try {
				const result = await stage({ messages, stepNumber: 1 } as never)
				items.push(...(result?.recordedContext ?? []))
			} catch {
				// a stage unrelated to the repository that needs more context than this test gives it
			}
		}
		return items.filter((item) => item.key === 'repository')
	}

	it('carries the real working tree and recent commits, once, and nothing while they are unchanged', async () => {
		const subject = `feat: snapshot-sentinel-${process.pid}`
		commit(repo, subject)
		const scratch = `scratch-${process.pid}.txt`
		writeFileSync(join(repo, scratch), 'untracked\n')

		const call = await drive(repo)
		const history: Message[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
		const [first] = await recorded(call, history)
		if (!first) throw new Error('the turn did not record the repository')

		expect(first.text, 'the untracked file only `git status` could have named').toContain(
			`?? ${scratch}`,
		)
		expect(first.text, 'the commit subject only `git log` could have produced').toContain(subject)
		expect(
			first.text,
			'names and subjects are text somebody wrote, landing in the request',
		).toMatch(/<namzu-untrusted-[0-9a-f]+ kind="repository-snapshot"/)

		history.push(createTurnContextEntry('repository', first.text))
		expect(
			await recorded(call, history),
			'a later iteration, with the entry in the history, adds nothing',
		).toEqual([])
	})

	it('is not in the cached system prompt', async () => {
		writeFileSync(join(repo, `dirty-${process.pid}.txt`), 'x\n')

		const call = await drive(repo)

		expect(String(call.systemPrompt ?? '')).not.toContain(`dirty-${process.pid}.txt`)
	})

	it('records nothing outside a repository rather than an empty heading', async () => {
		const plain = join(root, 'plain')
		mkdirSync(plain)

		const call = await drive(plain)

		expect(await recorded(call, [{ role: 'user', content: 'hi', timestamp: 0 }])).toEqual([])
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

describe('plan mode', () => {
	it('adds the plan-mode block to the prompt only for a turn run under plan', async () => {
		const session = await openSessionIn(repo)
		const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
		for await (const _ of session.send(messages, { permissionMode: 'plan' })) {
			// drain
		}
		for await (const _ of session.send(messages, { permissionMode: 'prompt' })) {
			// drain
		}
		expect(queryCalls.length).toBe(2)
		expect(String(queryCalls[0]?.systemPrompt ?? '')).toContain('## Plan mode')
		expect(String(queryCalls[1]?.systemPrompt ?? '')).not.toContain('## Plan mode')
	})
})

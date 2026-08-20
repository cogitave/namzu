/**
 * A project's `AGENTS.md` reaches the turn that is supposed to obey it.
 *
 * The chain is
 *
 *   AGENTS.md on disk → live tracker → createAgentSession()
 *                     → query() projectInstructionContext
 *                     → and, separately, the sub-agent config's context
 *
 * and the reason this test starts at a real file rather than at the loader is
 * that a loader test passes with every hop after it deleted. The composed
 * block being correct proves nothing about it being composed INTO anything;
 * the failure mode this feature invites is the string existing and being
 * dropped one function short of the provider, which is silent — the run
 * succeeds and writes code the project would reject, exactly as it did before
 * the feature existed.
 *
 * The sub-agent assertion is here rather than beside the other sub-agent tests
 * on purpose. Two paths carry the same signal, and one of two paths carrying a
 * signal is how this class of defect survives a green suite: the parent would
 * honour the project's rules and every task it delegated would quietly not.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import {
	type AgentDefinition,
	AgentRegistry,
	type Message,
	type ProjectInstructionContext,
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
let pkg: string

beforeEach(() => {
	queryCalls.length = 0
	root = mkdtempSync(join(tmpdir(), 'namzu-project-'))
	repo = join(root, 'repo')
	pkg = join(repo, 'pkg')
	mkdirSync(pkg, { recursive: true })
	// A real repository boundary, so nothing above the temp directory can leak
	// into the walk and make an assertion pass for the wrong reason.
	mkdirSync(join(repo, '.git'))
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

async function drive(cwd: string): Promise<{ systemPrompt: string; projectPrompt: string }> {
	const session = await openSessionIn(cwd)
	const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
	for await (const _ of session.send(messages)) {
		// drain
	}
	expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
	const call = queryCalls[0]
	const context = call?.projectInstructionContext as ProjectInstructionContext | undefined
	if (!context?.prepareInitialSnapshot) {
		throw new Error('query() did not receive the live project-instruction context')
	}
	const snapshot = await context.prepareInitialSnapshot({
		messages,
		signal: new AbortController().signal,
	})
	return {
		systemPrompt: String(call?.systemPrompt ?? ''),
		projectPrompt: snapshot?.content ?? '',
	}
}

describe("the project's instructions", () => {
	it('reach the retained project-context snapshot the turn is actually run with', async () => {
		writeFileSync(join(pkg, 'AGENTS.md'), '# House rules\n\nNever use a default export.')

		const { projectPrompt, systemPrompt } = await drive(pkg)

		expect(projectPrompt).toContain('Never use a default export.')
		expect(systemPrompt).not.toContain('Never use a default export.')
	})

	it('carry the whole ancestor chain, nearest last', async () => {
		writeFileSync(join(repo, 'AGENTS.md'), 'Repository rule: commits are signed.')
		writeFileSync(join(pkg, 'AGENTS.md'), 'Package rule: this package is generated.')

		const { projectPrompt } = await drive(pkg)

		expect(projectPrompt).toContain('Repository rule: commits are signed.')
		expect(projectPrompt).toContain('Package rule: this package is generated.')
		expect(
			projectPrompt.indexOf('Repository rule'),
			'the nearer file has to come last or its override never takes effect',
		).toBeLessThan(projectPrompt.indexOf('Package rule'))
	})

	it('do not displace the identity block or the memory that was already there', async () => {
		// The composition is a join over a list, and the ordinary way to break a
		// join is to replace an element instead of adding one. If the project
		// block arrived by overwriting `NAMZU_IDENTITY`, every assertion above
		// would still pass and the agent would have lost its anti-fabrication
		// rules to a file it found on disk.
		writeFileSync(join(pkg, 'AGENTS.md'), 'Never use a default export.')

		const { systemPrompt, projectPrompt } = await drive(pkg)

		expect(systemPrompt).toContain('You are namzu')
		expect(systemPrompt).toContain('CRITICAL — never fabricate')
		expect(projectPrompt).toContain('Never use a default export.')
	})

	it('add nothing to the prompt when the project declares none', async () => {
		const { systemPrompt, projectPrompt } = await drive(pkg)

		expect(projectPrompt).toBe('')
		// The loader returns `null` for "no file", and the composition is a join
		// over a list. Drop the filter that removes the empty slots and the
		// literal four characters `null` are sent to the model between the
		// identity block and the skills block, on every run in every directory
		// with no AGENTS.md — while the assertion above still passes.
		expect(systemPrompt, 'an absent block must be absent, not the word null').not.toContain('null')
		expect(systemPrompt, 'the identity block still has to be there').toContain('You are namzu')
	})

	it('are reported by the session, as the exact set that was injected', async () => {
		writeFileSync(join(repo, 'AGENTS.md'), 'Repository rule.')
		writeFileSync(join(pkg, 'AGENTS.md'), 'Package rule.')

		const session = await openSessionIn(pkg)

		expect(session.instructionFiles).toEqual([join(repo, 'AGENTS.md'), join(pkg, 'AGENTS.md')])
	})

	it('bind the sub-agents this session can delegate to', async () => {
		const registered: AgentDefinition[] = []
		vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation((def) => {
			for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
		})
		writeFileSync(join(pkg, 'AGENTS.md'), 'Never use a default export.')

		await openSessionIn(pkg)

		const general = registered.find((d) => d.info.id === 'general-purpose')
		if (!general?.configBuilder) {
			throw new Error('the sub-agent runtime did not stand up — this test proves nothing')
		}
		// `systemPrompt` is on the config the builder produces, not on the
		// definition: the definition is what a reader would reach for and it
		// carries no prompt at all.
		const config = (await general.configBuilder({})) as {
			systemPrompt?: string
			projectInstructionContext?: ProjectInstructionContext
		}
		const childPrompt = config.systemPrompt ?? ''
		const snapshot = await config.projectInstructionContext?.prepareInitialSnapshot?.({
			messages: [{ role: 'user', content: 'work', timestamp: 0 }],
			signal: new AbortController().signal,
		})
		expect(snapshot?.content).toContain('Never use a default export.')
		expect(
			childPrompt,
			"a delegated task must keep its own guardrails as well as the project's",
		).toContain('Never fabricate.')
	})
})

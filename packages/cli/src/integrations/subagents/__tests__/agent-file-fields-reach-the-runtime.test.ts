/**
 * The fields an agent file can set beyond its roster change what the agent
 * does: a denied tool is gone, a turn cap and an effort reach the child's
 * config, `background` is the default for a call that does not say, and
 * `isolation: worktree` gives the child its own checkout and keeps its launch
 * from skipping review.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type AgentDefinition,
	AgentRegistry,
	MockLLMProvider,
	SessionPaths,
	type ToolContext,
	type Toolset,
	getBuiltinTools,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { testToolset } from '../../../test-support/toolset.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import type { AgentFileDefinition } from '../definitions.js'
import { cappedTurns, createSubagentRuntime } from '../runtime.js'

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) removeTempDir(root)
})

function file(extra: Partial<AgentFileDefinition>): AgentFileDefinition {
	return {
		name: 'worker',
		description: 'Does the work.',
		prompt: 'WORKER-PROMPT',
		readOnly: false,
		path: '/p/.namzu/agents/worker.md',
		source: 'project',
		...extra,
	}
}

async function configFor(definition: AgentFileDefinition, limits?: { maxIterations?: number }) {
	const registered: AgentDefinition[] = []
	vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation(function (
		this: AgentRegistry,
		def,
	) {
		for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
	})
	vi.spyOn(AgentRegistry.prototype, 'replace').mockImplementation(function (
		this: AgentRegistry,
		_id,
		def,
	) {
		registered.push(def)
	})
	const parent = await subagentParentFixture(process.cwd())
	await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd: process.cwd(),
		model: 'session-model',
		buildProvider: () => new MockLLMProvider({ turns: [] }),
		buildTools: (): readonly Toolset[] => [testToolset(...getBuiltinTools())],
		definitions: [definition],
		...(limits?.maxIterations !== undefined ? { maxIterations: limits.maxIterations } : {}),
	})
	const built = registered.find((d) => d.info.id === definition.name)
	if (!built?.configBuilder) throw new Error('worker was not registered')
	const config = (await built.configBuilder({})) as unknown as {
		maxIterations: number
		effort?: string
		toolsets: readonly Toolset[]
	}
	return {
		maxIterations: config.maxIterations,
		effort: config.effort,
		names: config.toolsets.flatMap((ts) => ts.tools()).map((tool) => tool.name),
	}
}

describe('an agent file beyond its roster', () => {
	it('drops a denied tool even when the allowlist names it', async () => {
		const { names } = await configFor(
			file({ tools: ['read', 'grep', 'bash'], disallowedTools: ['bash'] }),
		)
		expect(names.sort()).toEqual(['grep', 'read'])
	})

	it('drops a denied tool from the whole working set when there is no allowlist', async () => {
		const { names } = await configFor(file({ disallowedTools: ['bash', 'write'] }))
		expect(names).toContain('read')
		expect(names).not.toContain('bash')
		expect(names).not.toContain('write')
	})

	it('runs with the effort the file names', async () => {
		expect((await configFor(file({ effort: 'high' }))).effort).toBe('high')
		expect((await configFor(file({}))).effort).toBeUndefined()
	})

	it('stops at its own turn cap, or the session limit when that is tighter', async () => {
		expect((await configFor(file({ maxTurns: 7 }))).maxIterations).toBe(7)
		expect((await configFor(file({ maxTurns: 7 }), { maxIterations: 3 })).maxIterations).toBe(3)
		expect(cappedTurns(0, 7)).toBe(7)
		expect(cappedTurns(10, 7)).toBe(7)
		expect(cappedTurns(5, undefined)).toBe(5)
	})
})

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

async function repoRuntime(definitions: readonly AgentFileDefinition[]) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-agent-file-fields-'))
	roots.push(root)
	const main = join(root, 'main')
	mkdirSync(main)
	git(main, 'init', '--quiet')
	git(main, 'config', 'user.name', 'Namzu Test')
	git(main, 'config', 'user.email', 'namzu-test@example.invalid')
	writeFileSync(join(main, 'base.txt'), 'base\n')
	git(main, 'add', 'base.txt')
	git(main, 'commit', '--quiet', '-m', 'base')
	const stateRoot = join(root, 'state')
	const parent = await subagentParentFixture(main)
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd: main,
		worktreeStateRoot: stateRoot,
		paths: new SessionPaths({ home: stateRoot, slug: 'agent-file-fields' }),
		model: 'mock-model',
		buildProvider: () => new MockLLMProvider({ turns: [{ text: 'done' }] }),
		buildTools: () => [],
		definitions,
	})
	const context = {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		abortSignal: new AbortController().signal,
	} as ToolContext
	return { runtime, context, main }
}

describe('isolation: worktree', () => {
	it('gives the child a checkout of its own when the call does not ask for one', async () => {
		const { runtime, context, main } = await repoRuntime([file({ isolation: 'worktree' })])
		try {
			const result = await runtime.agentTool.execute(
				{ description: 'edit alone', prompt: 'work', subagent_type: 'worker' },
				context,
			)
			expect(result.success, result.error ?? result.output).toBe(true)
			// The child changed nothing, so its checkout is gone again; being
			// removed (rather than never made) is what the result says.
			expect(result.output).toContain('The worktree had no changes and was removed.')
			expect(git(main, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
		} finally {
			await runtime.close()
		}
	})

	it('keeps a read-only file agent from starting without review', async () => {
		const { runtime } = await repoRuntime([
			file({ name: 'auditor', readOnly: true }),
			file({ name: 'isolated-auditor', readOnly: true, isolation: 'worktree' }),
		])
		try {
			expect(runtime.launchesReadOnlyAgent({ subagent_type: 'auditor' })).toBe(true)
			expect(runtime.launchesReadOnlyAgent({ subagent_type: 'isolated-auditor' })).toBe(false)
		} finally {
			await runtime.close()
		}
	})
})

describe('background: true', () => {
	it('returns at once for a call that does not say, and waits when the call says false', async () => {
		const { runtime, context } = await repoRuntime([file({ background: true })])
		try {
			const started = await runtime.agentTool.execute(
				{ description: 'in the background', prompt: 'work', subagent_type: 'worker' },
				context,
			)
			expect(started.success, started.error ?? started.output).toBe(true)
			expect(started.output).toContain('It runs in the background.')
			const waited = await runtime.agentTool.execute(
				{
					description: 'waits',
					prompt: 'work',
					subagent_type: 'worker',
					run_in_background: false,
				},
				context,
			)
			expect(waited.output).not.toContain('It runs in the background.')
			expect(waited.output).toContain('status: completed')
		} finally {
			await runtime.close()
		}
	})
})

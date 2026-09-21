import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, SessionPaths, ToolRegistry, mcpJsonSchemaToZod } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { CLI_CHECKPOINT_RETENTION } from '../../state/retention.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

/**
 * A delegated child keeps only the CLI's retention of checkpoints.
 *
 * The child runs through `ReactiveAgent`, whose turn config was a hand-listed
 * literal with no retention in it, so a long child kept every checkpoint
 * whatever the parent kept. Asserted on disk, after a real child turn through
 * the real stores, because the files left behind are what the bound is for.
 */

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

/** Checkpoint files per `checkpoints/` directory under `root`. */
function checkpointCounts(root: string): number[] {
	const counts: number[] = []
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			const path = join(dir, entry.name)
			if (entry.name === 'checkpoints') {
				counts.push(readdirSync(path).filter((name) => name.endsWith('.json')).length)
			} else {
				walk(path)
			}
		}
	}
	walk(root)
	return counts
}

it('bounds the checkpoints a delegated child leaves', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-retention-'))
	dirs.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const iterations = CLI_CHECKPOINT_RETENTION + 6
	const child = new MockLLMProvider({
		turns: [
			...Array.from({ length: iterations }, (_, n) => ({
				toolCalls: [{ id: `c${n}`, name: 'probe', args: { n } }],
			})),
			{ text: 'probed' },
		],
	})
	const buildTools = () => {
		const tools = new ToolRegistry()
		tools.register({
			name: 'probe',
			description: 'probe',
			inputSchema: mcpJsonSchemaToZod({
				type: 'object',
				properties: { n: { type: 'number' } },
				required: ['n'],
			}),
			execute: async () => ({ success: true, output: 'probed' }),
		})
		return tools
	}
	const stateRoot = join(cwd, 'state')
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'parent-model',
		resolveParent: parent.resolveParent,
		buildTools,
		buildProvider: () => child,
		// Nobody is at the terminal: approve every tool review so the child runs.
		resolveResumeHandler: () => async (request) =>
			request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' },
		paths: new SessionPaths({ home: stateRoot, slug: '-work-child-retention' }),
		maxIterations: iterations + 4,
	})
	try {
		const result = await runtime.agentTool.execute(
			{ description: 'probe', prompt: 'probe until done' },
			{
				sessionId: parent.scope.sessionId,
				turnId: parent.scope.turnId,
				workingDirectory: cwd,
				abortSignal: new AbortController().signal,
				env: {},
				log() {},
			},
		)
		if (!result.success) throw new Error(JSON.stringify(result))
	} finally {
		await runtime.close()
	}

	expect(child.requests.length).toBeGreaterThan(CLI_CHECKPOINT_RETENTION)
	const counts = checkpointCounts(stateRoot)
	expect(counts.length).toBeGreaterThan(0)
	expect(Math.max(...counts)).toBeLessThanOrEqual(CLI_CHECKPOINT_RETENTION)
})

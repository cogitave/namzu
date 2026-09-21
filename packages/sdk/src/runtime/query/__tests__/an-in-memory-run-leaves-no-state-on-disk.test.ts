import { existsSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import { defaultStateRoot } from '../../../session/workspace/state-root.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { CheckpointId } from '../../../types/hitl/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A run whose run store is in memory, with no path builder, writes nothing
 * under `defaultStateRoot()`.
 *
 * The run's evidence stayed in memory while its token ledger, its checkpoints
 * and their message history went to disk in the per-user state directory —
 * one tree per run, with no retention, in a place the host never named. The
 * packed `@namzu/live` fixture in `verify-consumer-install.sh` left one in the
 * operator's `~/.local/state/namzu` on every CI run.
 */

registerMock()

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function tools(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(
		defineTool({
			name: 'echo',
			description: 'echoes',
			inputSchema: z.object({ value: z.string() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async (input) => ({ success: true, output: input.value }),
		}),
	)
	return registry
}

function params(projectId: ReturnType<typeof generateProjectId>, workingDirectory: string) {
	return {
		// A tool call, so the run writes an iteration checkpoint as well as its ledger.
		provider: new MockLLMProvider({
			turns: [
				{
					toolCalls: [{ name: 'echo', args: { value: 'x' } }],
					finishReason: 'tool_calls' as const,
				},
				{ text: 'done' },
			],
		}),
		tools: tools(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user' as const, content: 'go' }],
		workingDirectory,
		runConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 200_000,
			maxIterations: 4,
			permissionMode: 'auto' as const,
		},
		projectId,
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		runStore: new InMemoryRunStore(),
	}
}

it('keeps the ledger and checkpoints in memory when the run store is', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-in-memory-run-'))
	dirs.push(workingDirectory)
	const projectId = generateProjectId()

	const run = await drainQuery(params(projectId, workingDirectory))

	expect(run.status).toBe('completed')
	expect(await readdir(workingDirectory)).toEqual([])
	expect(existsSync(join(defaultStateRoot(), 'projects', projectId))).toBe(false)
})

it('still writes to disk when the host names a path builder', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-in-memory-run-'))
	const root = await mkdtemp(join(tmpdir(), 'namzu-named-root-'))
	dirs.push(workingDirectory, root)
	const projectId = generateProjectId()

	const run = await drainQuery({
		...params(projectId, workingDirectory),
		pathBuilder: new DefaultPathBuilder(root),
	})

	expect(run.status).toBe('completed')
	expect(existsSync(join(root, 'projects', projectId))).toBe(true)
	expect(existsSync(join(defaultStateRoot(), 'projects', projectId))).toBe(false)
})

it('resumes in the same process from what the same run store holds', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-in-memory-run-'))
	dirs.push(workingDirectory)
	const projectId = generateProjectId()
	const base = params(projectId, workingDirectory)
	let checkpointId: CheckpointId | undefined

	const paused = await drainQuery({
		...base,
		resumeHandler: async (request) => {
			if (request.type !== 'iteration_checkpoint') return { action: 'continue' }
			checkpointId = request.checkpointId
			return { action: 'pause', reason: 'restart fixture' }
		},
	})
	expect(paused.stopReason).toBe('paused')
	if (!checkpointId) throw new Error('Expected an iteration checkpoint')

	// Same run store instance: its checkpoints and its ledger are still there.
	const resumed = await drainQuery({
		...base,
		runId: paused.id,
		messages: [],
		resumeFromCheckpoint: checkpointId,
	})
	expect(resumed.status).toBe('completed')
	expect(existsSync(join(defaultStateRoot(), 'projects', projectId))).toBe(false)
})

it('keeps the disk ledger when the host chose where checkpoints live', async () => {
	// Such a host may resume in a fresh process with a fresh run store, and the
	// checkpoint binds the run to its ledger by reference.
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-in-memory-run-'))
	dirs.push(workingDirectory)
	const projectId = generateProjectId()
	const checkpointStore = new InMemoryCheckpointStore()

	const run = await drainQuery({ ...params(projectId, workingDirectory), checkpointStore })

	expect(run.status).toBe('completed')
	expect(existsSync(join(defaultStateRoot(), 'projects', projectId))).toBe(true)
})

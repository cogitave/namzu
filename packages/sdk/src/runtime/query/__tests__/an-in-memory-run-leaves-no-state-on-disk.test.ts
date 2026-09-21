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
import type { TurnId } from '../../../types/ids/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { heldRunState } from '../session-storage.js'

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
		turnConfig: {
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
		turnId: paused.id,
		messages: [],
		resumeFromCheckpoint: checkpointId,
	})
	expect(resumed.status).toBe('completed')
	expect(existsSync(join(defaultStateRoot(), 'projects', projectId))).toBe(false)
})

it('keeps the ledger beside an in-memory checkpoint store the host passed', async () => {
	// The ledger lives where the checkpoints live. A resume with a fresh run
	// store and the same checkpoint store finds both; nothing goes to disk.
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-in-memory-run-'))
	dirs.push(workingDirectory)
	const projectId = generateProjectId()
	const checkpointStore = new InMemoryCheckpointStore()
	const base = { ...params(projectId, workingDirectory), checkpointStore }
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
	expect(existsSync(join(defaultStateRoot(), 'projects', projectId))).toBe(false)
	expect(await checkpointStore.tokenBudgets.load({ ...base, runId: paused.id })).not.toBeNull()

	const resumed = await drainQuery({
		...base,
		runStore: new InMemoryRunStore(),
		turnId: paused.id,
		messages: [],
		resumeFromCheckpoint: checkpointId,
	})
	expect(resumed.status).toBe('completed')
	expect(existsSync(join(defaultStateRoot(), 'projects', projectId))).toBe(false)
})

it('holds one run of state when one run store is reused for many runs', async () => {
	// A long-lived host reusing one InMemoryRunStore: each run's checkpoints and
	// ledger are released when the store is used for the next run, the way its
	// evidence is, instead of accumulating one set per run for the process's life.
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-in-memory-run-'))
	dirs.push(workingDirectory)
	const projectId = generateProjectId()
	const base = params(projectId, workingDirectory)
	const runStore = base.runStore
	const runIds: TurnId[] = []

	for (let i = 0; i < 10; i++) {
		const run = await drainQuery({
			...params(projectId, workingDirectory),
			...scopeOf(base),
			runStore,
		})
		expect(run.status).toBe('completed')
		runIds.push(run.id)
	}

	const heldNow = heldRunState(runStore)
	expect(heldNow?.runId).toBe(runIds.at(-1))
	const checkpoints = heldNow?.checkpoints
	if (!checkpoints) throw new Error('Expected the current run to be held')
	for (const runId of runIds.slice(0, -1)) {
		expect(await checkpoints.listCheckpoints({ ...scopeOf(base), runId })).toEqual([])
		expect(await checkpoints.tokenBudgets.load({ ...scopeOf(base), runId })).toBeNull()
	}
	const current = { ...scopeOf(base), runId: runIds.at(-1) as TurnId }
	expect((await checkpoints.listCheckpoints(current)).length).toBeGreaterThan(0)
	expect(await checkpoints.tokenBudgets.load(current)).not.toBeNull()
	expect(existsSync(join(defaultStateRoot(), 'projects', projectId))).toBe(false)
})

it('no longer resumes a run the reused run store has moved past', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-in-memory-run-'))
	dirs.push(workingDirectory)
	const projectId = generateProjectId()
	const base = params(projectId, workingDirectory)
	let checkpointId: CheckpointId | undefined

	const first = await drainQuery({
		...base,
		resumeHandler: async (request) => {
			if (request.type !== 'iteration_checkpoint') return { action: 'continue' }
			checkpointId = request.checkpointId
			return { action: 'pause', reason: 'restart fixture' }
		},
	})
	if (!checkpointId) throw new Error('Expected an iteration checkpoint')
	const second = await drainQuery({
		...params(projectId, workingDirectory),
		...scopeOf(base),
		runStore: base.runStore,
	})
	expect(second.status).toBe('completed')

	// Rebinding released the first run's checkpoints, exactly as it released
	// its evidence. A host that wants to come back to a run keeps its run
	// store for it, or names a checkpoint store.
	await expect(
		drainQuery({
			...base,
			provider: params(projectId, workingDirectory).provider,
			turnId: first.id,
			messages: [],
			resumeFromCheckpoint: checkpointId,
		}),
	).rejects.toThrow('missing checkpoint')
})

it("bounds the current run's checkpoints by retention, as on disk", async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-in-memory-run-'))
	dirs.push(workingDirectory)
	const projectId = generateProjectId()
	const base = params(projectId, workingDirectory)
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'echo', args: { value: 'a' } }], finishReason: 'tool_calls' as const },
			{ toolCalls: [{ name: 'echo', args: { value: 'b' } }], finishReason: 'tool_calls' as const },
			{ toolCalls: [{ name: 'echo', args: { value: 'c' } }], finishReason: 'tool_calls' as const },
			{ text: 'done' },
		],
	})

	const run = await drainQuery({
		...base,
		provider,
		turnConfig: { ...base.turnConfig, maxIterations: 6, pruneKeepLast: 1 },
	})

	expect(run.status).toBe('completed')
	const checkpoints = heldRunState(base.runStore)?.checkpoints
	if (!checkpoints) throw new Error('Expected the run to be held')
	expect(await checkpoints.listCheckpoints({ ...scopeOf(base), runId: run.id })).toHaveLength(1)
})

function scopeOf(base: ReturnType<typeof params>) {
	return {
		tenantId: base.tenantId,
		projectId: base.projectId,
		sessionId: base.sessionId,
		topicId: base.topicId,
	}
}

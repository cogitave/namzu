import { existsSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { resolveNamzuHome } from '../../../session/home.js'
import { SessionPaths, slugForCwd } from '../../../session/paths.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { CheckpointId } from '../../../types/hitl/index.js'
import type { SessionId } from '../../../types/ids/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { heldSessionState } from '../session-storage.js'
import { checkpointStoreFor, turnCheckpoints } from './support/session.js'

/**
 * A turn whose session log is in memory, with no `paths`, writes nothing to
 * disk: its checkpoints and its token ledger stay beside the log.
 *
 * The run's evidence once stayed in memory while its token ledger, its
 * checkpoints and their message history went to disk in the per-user state
 * directory — one tree per run, with no retention, in a place the host never
 * named. The packed `@namzu/live` fixture in `verify-consumer-install.sh` left
 * one in the operator's home on every CI run.
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

function params(workingDirectory: string, sessionId: SessionId = generateSessionId()) {
	return {
		// A tool call, so the turn writes an iteration checkpoint as well as its ledger.
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
		projectId: generateProjectId(),
		sessionId,
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		sessionLog: new InMemorySessionLog({ sessionId }),
	}
}

/** Whether anything was written for the working directory's project under `NAMZU_HOME`. */
function projectOnDisk(workingDirectory: string): boolean {
	return existsSync(join(resolveNamzuHome(), 'projects', slugForCwd(workingDirectory)))
}

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-in-memory-run-'))
	dirs.push(dir)
	return dir
}

const pauseAtCheckpoint =
	(seen: { checkpointId?: CheckpointId }) =>
	async (request: {
		type: string
		checkpointId?: CheckpointId
	}) => {
		if (request.type !== 'iteration_checkpoint') return { action: 'continue' as const }
		seen.checkpointId = request.checkpointId
		return { action: 'pause' as const, reason: 'restart fixture' }
	}

it('keeps the ledger and checkpoints in memory when the log is', async () => {
	const workingDirectory = await workdir()
	const base = params(workingDirectory)

	const turn = await drainQuery(base)

	expect(turn.status).toBe('completed')
	expect(await readdir(workingDirectory)).toEqual([])
	expect(projectOnDisk(workingDirectory)).toBe(false)
	expect(await turnCheckpoints({ ...base, turnId: turn.id })).not.toHaveLength(0)
})

it('still writes to disk when the host names the paths', async () => {
	const workingDirectory = await workdir()
	const home = await mkdtemp(join(tmpdir(), 'namzu-named-home-'))
	dirs.push(home)
	const paths = new SessionPaths({ home, slug: 'named-project' })
	const { sessionLog: _held, ...base } = params(workingDirectory)

	const turn = await drainQuery({ ...base, paths })

	expect(turn.status).toBe('completed')
	expect(existsSync(paths.sessionLog({ sessionId: base.sessionId }))).toBe(true)
	expect(existsSync(paths.checkpoints({ sessionId: base.sessionId }))).toBe(true)
	expect(projectOnDisk(workingDirectory)).toBe(false)
})

it('resumes in the same process from what the same log holds', async () => {
	const workingDirectory = await workdir()
	const base = params(workingDirectory)
	const seen: { checkpointId?: CheckpointId } = {}

	const paused = await drainQuery({ ...base, resumeHandler: pauseAtCheckpoint(seen) })
	expect(paused.stopReason).toBe('paused')
	if (!seen.checkpointId) throw new Error('Expected an iteration checkpoint')

	// Same log: its checkpoints and its ledger are still beside it.
	const resumed = await drainQuery({
		...base,
		turnId: paused.id,
		messages: [],
		resumeFromCheckpoint: seen.checkpointId,
	})
	expect(resumed.status).toBe('completed')
	expect(projectOnDisk(workingDirectory)).toBe(false)
})

it('keeps the ledger beside an in-memory log when the host passed its own checkpoint store', async () => {
	// The ledger lives beside the log. A resume through another instance of
	// the same log and the same checkpoint store finds both; nothing goes to
	// disk.
	const workingDirectory = await workdir()
	const base = params(workingDirectory)
	const checkpointStore = checkpointStoreFor(base.sessionLog)
	const seen: { checkpointId?: CheckpointId } = {}

	const paused = await drainQuery({
		...base,
		checkpointStore,
		resumeHandler: pauseAtCheckpoint(seen),
	})
	expect(paused.stopReason).toBe('paused')
	if (!seen.checkpointId) throw new Error('Expected an iteration checkpoint')
	expect(projectOnDisk(workingDirectory)).toBe(false)
	const ledger = await heldSessionState(base.sessionLog)?.tokenBudgets.load({
		rootSessionId: base.sessionId,
		rootTurnId: paused.id,
	})
	expect(ledger).not.toBeNull()

	const reopened = new InMemorySessionLog({
		sessionId: base.sessionId,
		medium: base.sessionLog.medium,
		leases: base.sessionLog.leaseStore,
		spills: base.sessionLog.spillStore,
	})
	const resumed = await drainQuery({
		...base,
		sessionLog: reopened,
		checkpointStore,
		turnId: paused.id,
		messages: [],
		resumeFromCheckpoint: seen.checkpointId,
	})
	expect(resumed.status).toBe('completed')
	expect(projectOnDisk(workingDirectory)).toBe(false)
})

it("bounds the turn's checkpoints by retention, as on disk", async () => {
	const workingDirectory = await workdir()
	const base = params(workingDirectory)
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'echo', args: { value: 'a' } }], finishReason: 'tool_calls' as const },
			{ toolCalls: [{ name: 'echo', args: { value: 'b' } }], finishReason: 'tool_calls' as const },
			{ toolCalls: [{ name: 'echo', args: { value: 'c' } }], finishReason: 'tool_calls' as const },
			{ text: 'done' },
		],
	})

	const turn = await drainQuery({
		...base,
		provider,
		turnConfig: { ...base.turnConfig, maxIterations: 6, pruneKeepLast: 1 },
	})

	expect(turn.status).toBe('completed')
	expect(await turnCheckpoints({ ...base, turnId: turn.id })).toHaveLength(1)
})

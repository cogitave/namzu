import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { SandboxConfigSchema } from '../../../types/sandbox/index.js'
import type { SandboxCreateConfig, SandboxProvider } from '../../../types/sandbox/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The sandbox could not confine the directory it was wanted for.
 *
 * `SandboxCreateConfig.workingDirectory` existed, the local provider ignored
 * it, and the kernel never set it: `drainQuery` built the sandbox from three
 * timeout/limit fields and dropped the run's own `cwd`. So a consumer
 * configuring a sandbox through `runConfig.sandbox` always got a temp
 * directory, whatever the run was working on.
 *
 * The direct SDK default stays ephemeral. Changing that would be a major and
 * would quietly point every existing embedded sandboxed run at real files.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** Records what `create()` was asked for; runs nothing. */
function recordingProvider(options: { workingDirectory?: boolean } = { workingDirectory: true }): {
	provider: SandboxProvider
	seen: SandboxCreateConfig[]
} {
	const seen: SandboxCreateConfig[] = []
	const provider = {
		id: 'recording',
		name: 'Recording sandbox',
		environment: 'basic' as const,
		...(options.workingDirectory
			? { workspaceModes: ['ephemeral', 'working-directory'] as const }
			: { workspaceModes: ['ephemeral'] as const }),
		create: async (config: SandboxCreateConfig) => {
			seen.push(config)
			return {
				id: 'sbx_test',
				rootDir: config.workingDirectory ?? join(tmpdir(), 'namzu-ephemeral'),
				exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
				dispose: async () => {},
			}
		},
	} as unknown as SandboxProvider
	return { provider, seen }
}

async function run(opts: {
	readonly workspace?: 'ephemeral' | 'working-directory'
	readonly withWorkingDirectory: boolean
}): Promise<{ seen: SandboxCreateConfig[]; run: Awaited<ReturnType<typeof drainQuery>> }> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-sbxroot-'))
	dirs.push(workingDirectory)
	const { provider, seen } = recordingProvider()

	const result = await drainQuery({
		provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
		tools: new ToolRegistry(),
		sandboxProvider: provider,
		runConfig: {
			model: 'mock-model',
			timeoutMs: 20_000,
			tokenBudget: 100_000,
			maxIterations: 2,
			...(opts.workspace ? { sandbox: { workspace: opts.workspace } } : {}),
		},
		agentId: 'agent_s',
		agentName: 'Sandboxed',
		messages: [createUserMessage('go')],
		...(opts.withWorkingDirectory ? { workingDirectory } : {}),
		sessionId: 'ses_s' as SessionId,
		topicId: 'top_s' as TopicId,
		projectId: 'prj_s' as ProjectId,
		tenantId: 'tnt_s' as TenantId,
	})

	return { seen, run: result }
}

describe('what a sandbox is rooted at', () => {
	it('names no directory when a raw config omits the key', async () => {
		// The direct-SDK path: `drainQuery` reads `runConfig.sandbox` as the
		// caller passed it, so an absent key is ephemeral by the comparison,
		// not by the schema. Flipping the schema default does NOT change this
		// — checked, and it is why the next test exists rather than this one
		// carrying a claim it cannot support.
		const { seen } = await run({ withWorkingDirectory: true })

		expect(seen).toHaveLength(1)
		expect(seen[0]?.workingDirectory).toBeUndefined()
	})

	it('stays ephemeral for a config that went through the schema', async () => {
		// The CLI path, and the one the schema default governs. Flipping that
		// default to 'working-directory' fails here — which is the assertion
		// the previous test looked like it was making and was not: it would
		// be a major, and it would silently point every already-configured
		// sandboxed run at the caller's real files.
		const resolved = SandboxConfigSchema.parse({ enabled: true })
		expect(resolved.workspace).toBe('ephemeral')

		const { seen } = await run({ workspace: resolved.workspace, withWorkingDirectory: true })

		expect(seen[0]?.workingDirectory).toBeUndefined()
	})

	it("passes the run's own cwd when the caller asks for it", async () => {
		// The whole defect: this argument was never populated. Reverting the
		// `create()` call site fails only this.
		const { seen } = await run({ workspace: 'working-directory', withWorkingDirectory: true })

		expect(seen).toHaveLength(1)
		expect(seen[0]?.workingDirectory).toBe(dirs[dirs.length - 1])
	})

	it('refuses rather than confining a directory nobody named', async () => {
		// `ctx.cwd` falls back to `process.cwd()`, so the tempting
		// implementation — read `ctx.cwd` — would root the sandbox at whatever
		// directory the host process is in. That is not the tree the caller
		// asked to confine. Falling back to ephemeral is the other wrong
		// answer: it reports success while confining nothing the caller meant.
		// `drainQuery` settles a thrown run rather than rejecting, so the
		// refusal shows up as a failed Run carrying the message — asserted
		// against the actual contract rather than the one that felt natural.
		const { run: failed } = await run({
			workspace: 'working-directory',
			withWorkingDirectory: false,
		})

		expect(failed.status).toBe('failed')
		expect(failed.lastError).toMatch(/sandbox\.workspace/)
	})

	it('does not create the sandbox at all when it refuses', async () => {
		// The refusal has to come BEFORE `create()`. A sandbox built and then
		// rejected has already made a directory and possibly a process.
		const { provider, seen } = recordingProvider()
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-sbxroot-'))
		dirs.push(workingDirectory)

		const failed = await drainQuery({
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			tools: new ToolRegistry(),
			sandboxProvider: provider,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 2,
				sandbox: { workspace: 'working-directory' },
			},
			agentId: 'agent_s',
			agentName: 'Sandboxed',
			messages: [createUserMessage('go')],
			sessionId: 'ses_s' as SessionId,
			topicId: 'top_s' as TopicId,
			projectId: 'prj_s' as ProjectId,
			tenantId: 'tnt_s' as TenantId,
		})

		expect(failed.status).toBe('failed')
		expect(seen, 'create() ran before the refusal').toHaveLength(0)
	})

	it('refuses a provider that would ignore the requested working directory', async () => {
		const { provider, seen } = recordingProvider({ workingDirectory: false })
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-sbxroot-'))
		dirs.push(workingDirectory)

		const failed = await drainQuery({
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			tools: new ToolRegistry(),
			sandboxProvider: provider,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 2,
				sandbox: { workspace: 'working-directory' },
			},
			workingDirectory,
			agentId: 'agent_s',
			agentName: 'Sandboxed',
			messages: [createUserMessage('go')],
			sessionId: 'ses_s' as SessionId,
			topicId: 'top_s' as TopicId,
			projectId: 'prj_s' as ProjectId,
			tenantId: 'tnt_s' as TenantId,
		})

		expect(failed.status).toBe('failed')
		expect(failed.lastError).toMatch(/does not advertise working-directory/)
		expect(seen).toHaveLength(0)
	})
})

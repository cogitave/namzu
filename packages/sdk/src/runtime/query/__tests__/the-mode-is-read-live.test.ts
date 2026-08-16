import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemoryTopicStateStore } from '../../../store/topic/state.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { PermissionMode } from '../../../types/permission/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The mode was frozen at run start, so leaving plan mode meant ending the
 * run.
 *
 * `permissionMode` was resolved once in the context factory and copied into
 * the executor's config, read from there on every call. Enforcement was
 * correct; the lifetime was the problem — the look-around, propose,
 * get-approval, continue-in-the-SAME-conversation flow could not be built
 * on it, and `approve_plan` already existed with its approval changing
 * nothing about the mode.
 */

registerMock()

const TOPIC = 'top_live' as TopicId
const TENANT = 'tnt_live' as TenantId

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function registry(): ToolRegistry {
	const r = new ToolRegistry()
	for (const [name, readOnly] of [
		['write', false],
		['read', true],
	] as const) {
		r.register(
			defineTool({
				name,
				description: name,
				inputSchema: z.object({}),
				category: 'filesystem',
				permissions: [],
				readOnly,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({ success: true, output: `${name} ran` }),
			}),
		)
	}
	return r
}

const call = (id: string, name: string) => ({
	toolCalls: [{ id, name, args: {} }],
	finishReason: 'tool_calls' as const,
})

async function run(opts: {
	turns: unknown[]
	permissionMode?: PermissionMode
	topicStateStore?: InMemoryTopicStateStore
	modeRef?: { current: PermissionMode }
	onBeforeTurn?: () => void
}) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-mode-'))
	dirs.push(workingDirectory)
	const provider = new MockLLMProvider({ turns: opts.turns as never })
	if (opts.onBeforeTurn) {
		const original = provider.chatStream.bind(provider)
		provider.chatStream = (p) => {
			opts.onBeforeTurn?.()
			return original(p)
		}
	}

	const result = await drainQuery({
		provider,
		tools: registry(),
		runConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 200_000,
			maxIterations: 6,
			...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
		},
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_l' as SessionId,
		topicId: TOPIC,
		projectId: 'prj_l' as ProjectId,
		tenantId: TENANT,
		...(opts.topicStateStore ? { topicStateStore: opts.topicStateStore } : {}),
		...(opts.modeRef ? { permissionModeRef: opts.modeRef } : {}),
	})

	return result.messages
		.filter((m) => m.role === 'tool' && typeof m.content === 'string')
		.map((m) => m.content as string)
}

describe('the mode is read live, not frozen at run start', () => {
	it('refuses a write in plan mode and allows it after the mode flips, in ONE run', async () => {
		// The whole point. Before this, leaving plan mode meant ending the run
		// and discarding the in-flight step and tool-schema context.
		const modeRef = { current: 'plan' as PermissionMode }
		let turn = 0

		const outputs = await run({
			turns: [call('t1', 'write'), call('t2', 'write'), { text: 'done' }],
			permissionMode: 'plan',
			modeRef,
			onBeforeTurn: () => {
				// Flipped between the first batch and the second, exactly as an
				// approved plan does.
				turn++
				if (turn === 2) modeRef.current = 'auto'
			},
		})

		expect(outputs[0]).toMatch(/plan mode/i)
		expect(outputs[1]).toContain('write ran')
	})

	it('takes the mode from the topic record when the run config names none', async () => {
		const topicStateStore = new InMemoryTopicStateStore()
		await topicStateStore.setPermissionMode(TOPIC, TENANT, 'plan', { revision: 0 })

		const outputs = await run({ turns: [call('t1', 'write'), { text: 'done' }], topicStateStore })

		expect(outputs[0]).toMatch(/plan mode/i)
	})

	it('lets an explicit run config beat the topic record', async () => {
		// The no-behaviour-change guarantee for every existing caller. A host
		// that says what it wants outranks a record it may not know about.
		const topicStateStore = new InMemoryTopicStateStore()
		await topicStateStore.setPermissionMode(TOPIC, TENANT, 'plan', { revision: 0 })

		const outputs = await run({
			turns: [call('t1', 'write'), { text: 'done' }],
			permissionMode: 'auto',
			topicStateStore,
		})

		expect(outputs[0]).toContain('write ran')
	})

	it('behaves exactly as before with no topic store at all', async () => {
		// The overwhelmingly common case, and the one a new read path is most
		// likely to disturb.
		const outputs = await run({ turns: [call('t1', 'write'), { text: 'done' }] })

		expect(outputs[0]).toContain('write ran')
	})

	it('samples the mode once per batch, so a flip cannot half-apply', async () => {
		// A batch where the first write is refused and the second succeeds is
		// not a state anyone can reason about. The flip lands mid-batch here;
		// every call in that batch must see the mode the batch started with.
		//
		// Note what this does NOT prove: removing the executor's explicit
		// per-batch sample leaves it green, because `buildToolContext()`
		// already runs once per batch and every call spreads its result. The
		// property is structural today and this pins the BEHAVIOUR — which is
		// what has to hold if that structure ever moves. Measured rather than
		// assumed; see the note on `batchMode`.
		const modeRef = { current: 'plan' as PermissionMode }
		const registryWithFlip = new ToolRegistry()
		// The flipper is READ-ONLY, and that is the whole trick. A write is
		// refused in plan mode BEFORE its body runs, so a write that flips the
		// mode never gets to — a first version of this test used one and
		// passed against a per-call read as happily as against a per-batch
		// sample. A read is allowed, its body runs, and the flip lands between
		// the checks of the writes that follow it in the same batch.
		registryWithFlip.register(
			defineTool({
				name: 'read',
				description: 'read',
				inputSchema: z.object({}),
				category: 'filesystem',
				permissions: [],
				readOnly: true,
				destructive: false,
				// Serial, so the flip is ordered BEFORE the writes are checked.
				// Parallel calls have every context built before any body runs.
				concurrencySafe: false,
				execute: async () => {
					modeRef.current = 'auto'
					return { success: true, output: 'read ran' }
				},
			}),
		)
		registryWithFlip.register(
			defineTool({
				name: 'write',
				description: 'write',
				inputSchema: z.object({}),
				category: 'filesystem',
				permissions: [],
				readOnly: false,
				destructive: false,
				concurrencySafe: false,
				execute: async () => ({ success: true, output: 'write ran' }),
			}),
		)

		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-mode-batch-'))
		dirs.push(workingDirectory)
		const result = await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{ id: 'a', name: 'read', args: {} },
							{ id: 'b', name: 'write', args: {} },
							{ id: 'c', name: 'write', args: {} },
						],
						finishReason: 'tool_calls',
					},
					{ toolCalls: [{ id: 'd', name: 'write', args: {} }], finishReason: 'tool_calls' },
					{ text: 'done' },
				] as never,
			}),
			tools: registryWithFlip,
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 200_000,
				maxIterations: 4,
				permissionMode: 'plan',
			},
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go')],
			workingDirectory,
			sessionId: 'ses_b' as SessionId,
			topicId: TOPIC,
			projectId: 'prj_b' as ProjectId,
			tenantId: TENANT,
			permissionModeRef: modeRef,
		})

		const outputs = result.messages
			.filter((m) => m.role === 'tool' && typeof m.content === 'string')
			.map((m) => m.content as string)

		// The read ran; both writes in the SAME batch were still refused,
		// because the batch sampled the mode once at its start.
		expect(outputs[0]).toContain('read ran')
		expect(outputs[1]).toMatch(/plan mode/i)
		expect(outputs[2]).toMatch(/plan mode/i)
		// And the NEXT batch saw the new mode. A per-run read fails here.
		expect(outputs[3]).toContain('write ran')
	})
})

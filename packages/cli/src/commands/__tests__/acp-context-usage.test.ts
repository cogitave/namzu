import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { AgentSession } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

/** The desktop's context panel asks the runtime where a conversation's window goes. */

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-acp-context-'))
	cwd = join(root, 'project')
	mkdirSync(cwd)
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function setup(events: (emit: (event: Record<string, unknown>) => void) => void) {
	let emit: (event: SessionEvent) => void = () => {}
	const send: AgentSession['send'] = async function* () {
		events((event) => emit(event as unknown as SessionEvent))
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const deps = {
		probe: async () => ({
			preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
			detected: [],
		}),
		decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
		resolveProjectContext: (value: unknown) => value,
		resolveSession: async (sessionId: string) => ({ sessionId }),
		createSession: async (
			_preferences: unknown,
			_detected: unknown,
			options: { onSessionEvent?: (event: SessionEvent) => void },
		) => {
			emit = (event) => options.onSessionEvent?.(event)
			return {
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				send,
				close: async () => {},
				presenter: {
					presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
					presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
				},
				jobs: () => [],
				instructionFiles: [],
				mcpStatus: () => ({ connected: [], failed: [] }),
				contextInventory: () => ({
					systemPrompt: 'p'.repeat(4_000),
					tools: [
						{ name: 'read_file', tokens: 300 },
						{ name: 'mcp__docs__search', tokens: 200, server: 'docs' },
					],
					deferredTools: [{ name: 'mcp__docs__rare', tokens: 700, server: 'docs' }],
				}),
			}
		},
	} as unknown as AcpRuntimeDependencies
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
		deps,
	)
	const prompt = () =>
		runtime.gateway.prompt({
			sessionId: 'session-context',
			cwd,
			prompt: 'hello',
			history: [],
			signal: new AbortController().signal,
			onEvent() {},
			ask: async () => ({ kind: 'approve' }),
			filesystem: undefined,
		})
	return { runtime, prompt }
}

const usage = (over: Record<string, unknown>) => ({
	type: 'token_usage_updated',
	sessionId: 'session-context',
	contextTokens: 20_000,
	contextWindowTokens: 200_000,
	contextMeasuredBy: 'provider',
	windowSource: 'provider',
	...over,
})

it('answers null before the engine has reported a window', async () => {
	const { runtime, prompt } = setup(() => {})
	await prompt()
	expect(await runtime.contextUsage?.('session-context', 'summary')).toBeNull()
	expect(await runtime.contextUsage?.('nobody', 'summary')).toBeNull()
})

it('splits a measured window, sizes the deferred tools apart and draws the reserve', async () => {
	const { runtime, prompt } = setup((emit) => emit(usage({})))
	await prompt()
	const report = await runtime.contextUsage?.('session-context', 'full')
	expect(report).toMatchObject({
		measuredBy: 'provider',
		windowTokens: 200_000,
		totalTokens: 20_000,
		percentage: 10,
		approximate: false,
		autoCompact: { enabled: true, bufferTokens: 33_000, thresholdTokens: 167_000 },
	})
	const byId = Object.fromEntries((report?.categories ?? []).map((row) => [row.id, row]))
	expect(byId['system-prompt']?.tokens).toBe(1_000)
	expect(byId['system-tools']?.tokens).toBe(300)
	expect(byId['mcp-tools']?.tokens).toBe(200)
	// Built-in skills are always offered, so their share is whatever the report says it is.
	const skills = byId.skills?.tokens ?? 0
	expect(byId.messages?.tokens).toBe(20_000 - 1_000 - 300 - 200 - skills)
	expect(byId['deferred-mcp-tools']).toMatchObject({ tokens: 700, kind: 'deferred' })
	expect(byId.buffer?.tokens).toBe(33_000)
	expect(byId.free?.tokens).toBe(200_000 - 20_000 - 33_000)
	expect(report?.lists?.mcpTools).toEqual([{ name: 'search', server: 'docs', tokens: 200 }])
	expect(report?.lists?.deferredTools).toEqual([{ name: 'rare', server: 'docs', tokens: 700 }])
})

it('leaves the lists out of a summary', async () => {
	const { runtime, prompt } = setup((emit) => emit(usage({})))
	await prompt()
	expect((await runtime.contextUsage?.('session-context', 'summary'))?.lists).toBeUndefined()
})

it('keeps Messages whole when the kernel only estimated the size', async () => {
	// The estimate is messages (5,000) plus the tool catalogue (500); the 1,000 of instructions sit on top.
	const { runtime, prompt } = setup((emit) =>
		emit(usage({ contextTokens: 5_500, contextMeasuredBy: 'estimate' })),
	)
	await prompt()
	const report = await runtime.contextUsage?.('session-context', 'summary')
	const messages = report?.categories.find((row) => row.id === 'messages')
	const skills = report?.categories.find((row) => row.id === 'skills')?.tokens ?? 0
	expect(messages?.tokens).toBe(5_000)
	expect(report?.totalTokens).toBe(6_500 + skills)
	expect(report?.measuredBy).toBe('estimate')
	expect(report?.approximate).toBe(true)
})

it('says the sizes are out of date after a shortening, until the next count from the provider', async () => {
	const { runtime, prompt } = setup((emit) => {
		emit(usage({}))
		emit({
			type: 'compaction_completed',
			sessionId: 'session-context',
			tokensBefore: 150_000,
			tokensAfter: 8_000,
			contextWindowTokens: 200_000,
		})
	})
	await prompt()
	const report = await runtime.contextUsage?.('session-context', 'summary')
	expect(report?.sizeOutOfDate).toBe(true)
	expect(report?.approximate).toBe(true)
	const skills = report?.categories.find((row) => row.id === 'skills')?.tokens ?? 0
	expect(report?.totalTokens).toBe(8_000 + 1_000 + skills)
})

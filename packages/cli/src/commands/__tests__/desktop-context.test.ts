import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createContextTracker, readContextRequest } from '../desktop-context.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

describe('the context request', () => {
	it('reads a session and an optional detail, and nothing else', () => {
		expect(readContextRequest({ sessionId: 's' })).toEqual({ sessionId: 's', detail: 'summary' })
		expect(readContextRequest({ sessionId: 's', detail: 'full' }).detail).toBe('full')
		for (const bad of [
			null,
			[],
			{},
			{ sessionId: '' },
			{ sessionId: 's', detail: 'all' },
			{ sessionId: 's', path: '/etc' },
		])
			expect(() => readContextRequest(bad)).toThrow('Invalid context request.')
	})
})

describe('the figures kept from the engine', () => {
	const usage = (over: Record<string, unknown>) =>
		({
			type: 'token_usage_updated',
			contextTokens: 10,
			contextWindowTokens: 100,
			contextMeasuredBy: 'provider',
			windowSource: 'model-table',
			...over,
		}) as unknown as SessionEvent

	it('knows nothing before a window is reported, and ignores a report without one', () => {
		const tracker = createContextTracker()
		expect(tracker.figures('a')).toBeUndefined()
		tracker.observe('a', usage({ contextWindowTokens: undefined }))
		expect(tracker.figures('a')).toBeUndefined()
	})

	it('keeps the last size, who counted it and where the window came from', () => {
		const tracker = createContextTracker()
		tracker.observe('a', usage({}))
		expect(tracker.figures('a')).toMatchObject({
			tokens: 10,
			windowTokens: 100,
			measuredBy: 'provider',
			windowSource: 'model-table',
		})
	})

	it('marks sizes out of date after a shortening and clears it on the next count from the provider', () => {
		const tracker = createContextTracker()
		tracker.observe('a', usage({}))
		tracker.observe('a', {
			type: 'compaction_completed',
			tokensAfter: 4,
			contextWindowTokens: 100,
		} as unknown as SessionEvent)
		expect(tracker.figures('a')).toMatchObject({
			tokens: 4,
			measuredBy: 'estimate',
			sizeOutOfDate: true,
		})
		tracker.observe('a', usage({ contextTokens: 5, contextMeasuredBy: 'estimate' }))
		expect(tracker.figures('a')?.sizeOutOfDate).toBe(true)
		tracker.observe('a', usage({ contextTokens: 6 }))
		expect(tracker.figures('a')?.sizeOutOfDate).toBeUndefined()
	})

	it('moves its version when a turn or a shortening ends, so lists are read again', () => {
		const tracker = createContextTracker()
		tracker.observe('a', usage({}))
		const before = tracker.figures('a')?.version
		tracker.observe('a', { type: 'turn_completed' } as unknown as SessionEvent)
		expect(tracker.figures('a')?.version).toBe((before ?? 0) + 1)
	})

	it('forgets a conversation that closed', () => {
		const tracker = createContextTracker()
		tracker.observe('a', usage({}))
		tracker.forget('a')
		expect(tracker.figures('a')).toBeUndefined()
	})
})

describe('the host method', () => {
	let root: string
	let cwd: string
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'namzu-desktop-context-'))
		cwd = join(root, 'project')
		mkdirSync(join(cwd, '.git'), { recursive: true })
		mkdirSync(join(root, 'state'))
		vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		removeTempDir(root)
	})

	it('is offered and refuses a loose request', async () => {
		const owner = createCliAcpRuntime(
			{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
			{
				decideTrust: decideHeadlessTrust,
				resolveSession: async (sessionId: string) => ({ sessionId }),
			} as unknown as AcpRuntimeDependencies,
		)
		const host = createDesktopHostExtensions(owner, cwd)
		expect(Object.keys(host)).toContain('namzu/session/context')
		await expect(host['namzu/session/context']({ sessionId: 's', extra: 1 })).rejects.toThrow(
			'Invalid context request.',
		)
	})
})

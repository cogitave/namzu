import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { ToolRegistry } from '../../../registry/index.js'
import { MarkdownMemoryStore } from '../../../store/memory/markdown.js'
import { createMemoryRecallStep } from '../../../turn/memory-recall.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { buildMemoryTools } from '../index.js'

const context: ToolContext = {
	sessionId: generateSessionId(),
	turnId: generateTurnId(),
	workingDirectory: process.cwd(),
	abortSignal: new AbortController().signal,
	env: {},
	log() {},
}

const roots: string[] = []
afterEach(async () => {
	vi.useRealTimers()
	await removeTempDirs(roots.splice(0))
})

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), 'namzu-typed-tools-'))
	roots.push(directory)
	const store = new MarkdownMemoryStore({ directory })
	const registry = new ToolRegistry()
	registry.register(buildMemoryTools(store))
	return { store, registry }
}

describe('typed memory through the model tools', () => {
	it('saves a typed, named memory and refuses a second save under that name', async () => {
		const { store, registry } = await fixture()
		const saved = await registry.execute(
			'save_memory',
			{
				title: 'Changesets are required',
				summary: 'Every publishable change needs a changeset.',
				content:
					'Add .changeset/<slug>.md.\nWhy: releases are driven by it.\nHow to apply: on every PR.',
				name: 'changesets-required',
				type: 'feedback',
				description: 'Publishable changes need a changeset',
			},
			context,
		)
		expect(saved.success).toBe(true)
		expect(saved.output).toContain('as changesets-required')
		const [entry] = (await store.list()).entries
		expect(entry).toMatchObject({
			type: 'feedback',
			description: 'Publishable changes need a changeset',
		})

		const duplicate = await registry.execute(
			'save_memory',
			{
				title: 'again',
				summary: 's',
				content: 'c',
				name: 'changesets-required',
			},
			context,
		)
		expect(duplicate.success).toBe(false)
		expect(duplicate.output).toContain(entry?.id)
		expect(duplicate.output).toContain('update_memory')
		expect((await store.list()).totalCount).toBe(1)
	})

	it('reads by name and resolves [[links]], including a missing one', async () => {
		const { store, registry } = await fixture()
		const target = await store.create({
			title: 't',
			summary: 's',
			content: 'c',
			name: 'deploy-window',
			description: 'When deploys may go out',
		})
		await store.create({
			title: 't',
			summary: 's',
			content: 'Freeze follows [[deploy-window]] and [[nowhere]].',
			name: 'release-freeze',
		})
		const read = await registry.execute('read_memory', { id: 'release-freeze' }, context)
		expect(read.success).toBe(true)
		expect(read.output).toContain('Freeze follows [[deploy-window]]')
		expect(read.output).toContain(
			`- [[deploy-window]] → ${target.entry.id} — When deploys may go out`,
		)
		expect(read.output).toContain('- [[nowhere]] → no memory has this name')
		expect(read.output).toContain('(today)')
		expect(read.output).not.toContain('point-in-time')
		expect((await registry.execute('read_memory', { id: 'no-such-name' }, context)).success).toBe(
			false,
		)
	})

	it('shows the age of an old memory and asks the model to verify before relying on it', async () => {
		const { store, registry } = await fixture()
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
		const { entry } = await store.create({
			title: 'Retry helper',
			summary: 'The retry helper lives in retryWithBackoff',
			content: 'Use retryWithBackoff in src/net/retry.ts for cerulean requests.',
			name: 'retry-helper',
		})
		vi.setSystemTime(new Date('2026-09-21T00:00:00Z'))

		const read = await registry.execute('read_memory', { id: entry.id }, context)
		expect(read.output).toContain('Last updated 2026-09-01 (20 days old)')
		expect(read.output).toContain('Verify it against the current code before relying on it')

		const search = await registry.execute('search_memory', { query: 'retry' }, context)
		expect(search.output).toContain('(retry-helper, project, 20 days old)')

		const recall = await createMemoryRecallStep({ store })({
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			stepNumber: 1,
			messages: [createUserMessage('How do cerulean requests retry?')],
			steps: [],
			prepared: {},
		})
		expect(recall?.system).toContain('"age":"20 days old"')
		expect(recall?.system).toContain('"name":"retry-helper"')
		expect(recall?.system).toContain('Verify it against the current code')
	})

	it('adds no verification notice to recall of a fresh memory', async () => {
		const { store } = await fixture()
		await store.create({
			title: 'Cerulean cache',
			summary: 's',
			content: 'cerulean-cache is 14 hours',
		})
		const recall = await createMemoryRecallStep({ store })({
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			stepNumber: 1,
			messages: [createUserMessage('cerulean-cache expiry?')],
			steps: [],
			prepared: {},
		})
		expect(recall?.system).toContain('14 hours')
		expect(recall?.system).not.toContain('"age"')
		expect(recall?.system).not.toContain('point-in-time')
	})

	it('updates a memory by the name the index shows, as well as by id', async () => {
		const { store, registry } = await fixture()
		const { entry } = await store.create({
			title: 'Config',
			summary: 's',
			content: 'c',
			name: 'cfg',
		})
		const archived = await registry.execute(
			'update_memory',
			{ id: 'cfg', status: 'archived' },
			context,
		)
		expect(archived).toMatchObject({ success: true, data: { id: entry.id, name: 'cfg' } })
		expect((await store.getRecord(entry.id))?.entry.status).toBe('archived')
		const missing = await registry.execute(
			'update_memory',
			{ id: 'no-such-name', status: 'archived' },
			context,
		)
		expect(missing.success).toBe(false)
		expect(missing.output).toContain('No memory is named no-such-name')
	})

	it('returns a JSON memory body exactly as stored, its age in data', async () => {
		const { store, registry } = await fixture()
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		const { entry } = await store.create({
			title: 'Settings',
			summary: 's',
			content: '{"a":1}',
			format: 'json',
		})
		vi.setSystemTime(new Date('2026-09-21T00:00:00Z'))
		const read = await registry.execute('read_memory', { id: entry.id }, context)
		expect(read.output).toBe('{"a":1}')
		expect(JSON.parse(read.output)).toEqual({ a: 1 })
		expect(read.data).toMatchObject({ updatedAt: entry.updatedAt })
	})

	it('answers a save the store cannot hold with a failed result, not a thrown error', async () => {
		const { registry } = await fixture()
		const saved = await registry.execute(
			'save_memory',
			{ title: 'big', summary: 's', content: 'x'.repeat(300 * 1024) },
			context,
		)
		expect(saved).toMatchObject({ success: false, data: { reason: 'too_large' } })
		const next = await registry.execute(
			'save_memory',
			{ title: 'small', summary: 's', content: 'c' },
			context,
		)
		expect(next.success).toBe(true)
	})
})

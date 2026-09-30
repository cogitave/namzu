import { describe, expect, it } from 'vitest'
import type {
	SourceConversationBinding,
	SourceDelivery,
	SourceDeliveryPage,
} from '../../schedule/delivery.js'
import { schedulePaths } from '../../schedule/paths.js'
import {
	SourceDeliveryView,
	sourceConversationBinding,
	sourceDeliveryLine,
	sourceDeliveryReadError,
} from './source-deliveries.js'

const source: SourceConversationBinding = {
	kind: 'source-conversation',
	sessionId: 'session-one',
	projectSlug: 'project-one',
	projectId: 'project-one-id',
	tenantId: 'tenant-one-id',
}
const paths = schedulePaths('/tmp/namzu-source-delivery-view')

function entry(overrides: Partial<SourceDelivery> = {}): SourceDelivery {
	return {
		v: 1,
		kind: 'schedule-source-delivery',
		source,
		jobId: 'job-one',
		jobName: 'status-check',
		runId: 'run-one',
		status: 'completed',
		at: '2026-09-30T09:00:00.000Z',
		summary: 'A change needs attention.',
		...overrides,
	}
}

function page(entries: readonly SourceDelivery[]): SourceDeliveryPage {
	return { entries, hasMore: false }
}

describe('source delivery transcript projection', () => {
	it('binds only a materialized conversation in the exact project and tenant', () => {
		const sessions = {
			slug: source.projectSlug,
			projectId: source.projectId,
			tenantId: source.tenantId,
		}
		const scope = {
			sessionId: source.sessionId,
			projectId: source.projectId,
			tenantId: source.tenantId,
		}
		expect(sourceConversationBinding(sessions, scope, false)).toBeUndefined()
		expect(
			sourceConversationBinding(sessions, { ...scope, projectId: 'other' }, true),
		).toBeUndefined()
		expect(
			sourceConversationBinding(sessions, { ...scope, tenantId: 'other' }, true),
		).toBeUndefined()
		expect(sourceConversationBinding(sessions, scope, true)).toEqual(source)
		for (const field of ['slug', 'projectId', 'tenantId'] as const)
			expect(sourceConversationBinding({ ...sessions, [field]: '' }, scope, true)).toBeUndefined()
		expect(sourceConversationBinding(sessions, { ...scope, sessionId: '' }, true)).toBeUndefined()
		expect(
			sourceConversationBinding({} as typeof sessions, {} as typeof scope, true),
		).toBeUndefined()
	})

	it('shows each immutable event once per transcript and repeats it after a conversation switch', async () => {
		const first = entry()
		const later = entry({
			status: 'failed',
			at: '2026-09-30T09:01:00.000Z',
			reason: 'check failed',
		})
		let values = [first]
		const view = new SourceDeliveryView(async () => page(values))
		expect(await view.poll(paths, source, 1)).toEqual([first])
		expect(await view.poll(paths, source, 1)).toEqual([])
		values = [first, later]
		expect(await view.poll(paths, source, 1)).toEqual([later])
		view.reset()
		expect(await view.poll(paths, source, 2)).toEqual([first, later])
	})

	it('discards a slow read from a transcript that was replaced', async () => {
		let finishOld: ((value: SourceDeliveryPage) => void) | undefined
		const oldRead = new Promise<SourceDeliveryPage>((resolve) => {
			finishOld = resolve
		})
		const nextSource = { ...source, sessionId: 'session-two' }
		const view = new SourceDeliveryView(async (_, binding) =>
			binding.sessionId === source.sessionId
				? oldRead
				: page([entry({ source: nextSource, runId: 'run-two' })]),
		)
		const pending = view.poll(paths, source, 1)
		const current = await view.poll(paths, nextSource, 2)
		expect(current.map((row) => row.runId)).toEqual(['run-two'])
		finishOld?.(page([entry()]))
		expect(await pending).toEqual([])
		expect(await view.poll(paths, nextSource, 2)).toEqual([])
	})

	it('drains every page of a source inbox without clipping after the first 100', async () => {
		const values = Array.from({ length: 205 }, (_, index) => entry({ runId: `run-${index}` }))
		const view = new SourceDeliveryView(async (_paths, _binding, cursor) => {
			const start = cursor ? cursor.order + 1 : 0
			const entries = values.slice(start, start + 100)
			return {
				entries,
				...(entries.length > 0
					? { cursor: { order: start + entries.length - 1, file: 'test-page' } }
					: cursor
						? { cursor }
						: {}),
				hasMore: start + entries.length < values.length,
			}
		})
		const first = await view.poll(paths, source, 1)
		const second = await view.poll(paths, source, 1)
		const third = await view.poll(paths, source, 1)
		expect([first.length, second.length, third.length]).toEqual([100, 100, 5])
		expect([...first, ...second, ...third].map((row) => row.runId)).toEqual(
			values.map((row) => row.runId),
		)
		expect(await view.poll(paths, source, 1)).toEqual([])
	})

	it('renders a visible host row without terminal control characters', () => {
		const line = sourceDeliveryLine(entry({ summary: 'updated\u001b[2J' }))
		expect(line).toContain('Scheduled: status-check · completed')
		expect(line).toContain('Result: updated')
		expect(line).not.toContain('\u001b')
	})

	it('makes a damaged inbox visible without including terminal controls', () => {
		const line = sourceDeliveryReadError(new Error('bad file\u001b[2J'))
		expect(line).toContain('Scheduled results could not be read: bad file')
		expect(line).toContain('Unread results remain')
		expect(line).not.toContain('\u001b')
	})
})

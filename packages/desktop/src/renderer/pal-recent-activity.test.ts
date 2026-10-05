import type { AcpSessionUpdate } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import { palToolActivity } from './pal-activity.js'
import { PalContextCard } from './pal-context.js'
import { palRecentActivity } from './pal-recent-activity.js'

function call(
	thread: ThreadState,
	id: string,
	title: string,
	status: 'pending' | 'completed' | 'failed',
) {
	const update: AcpSessionUpdate = {
		kind: 'tool_call',
		toolCallId: id,
		title,
		status,
		view: {
			kind: 'generic',
			label: 'private body, recipient ID and receipt metadata',
		},
	}
	return applyEvent(thread, {
		kind: 'update',
		projectId: 'project',
		sessionId: 'session',
		update,
	})
}

it('describes inbox acceptance without claiming reading, reply or exposing tool receipts on the Pal card', () => {
	let thread = call(emptyThread(), 'list', 'list_pals', 'completed')
	thread = call(thread, 'send', 'send_pal_message', 'completed')
	const before = structuredClone(thread)
	const activity = palRecentActivity(thread)
	expect(activity.map((row) => [row.title, row.detail])).toEqual([
		['Message to another Pal', 'Sent to inbox'],
		['Available Pals', 'Checked'],
	])
	const html = renderToStaticMarkup(
		createElement(PalContextCard, {
			pal: {
				id: 'private-pal-id',
				name: 'Palu',
				purpose: '',
				revision: 1,
				workspace: 'owned',
				model: null,
				paused: false,
				createdAt: '2026-10-06',
				updatedAt: '2026-10-06',
			},
			status: 'idle',
			computer: {
				name: 'Palu’s computer',
				workspace: 'owned',
				status: 'error',
			},
			activity,
			outputs: [],
			onCustomize: () => {},
		}),
	)
	for (const text of [
		'send_pal_message',
		'list_pals',
		'private',
		'receipt metadata',
		'Replied',
		'Read by',
	])
		expect(html).not.toContain(text)
	expect(html).toContain('Sent to inbox')
	expect(html).not.toContain('View details')
	expect(html).toMatch(/<div class="pal-context-row pal-recent-action" data-status="done">/)
	expect(thread).toEqual(before)
	expect(palToolActivity(thread)[1].tool.view).toEqual({
		kind: 'generic',
		label: 'private body, recipient ID and receipt metadata',
	})
})

it('distinguishes working, stopped and failed actions and keeps plan failures visible', () => {
	let thread = call(
		applyEvent(emptyThread(), {
			kind: 'state',
			sessionId: 'session',
			running: true,
			queued: [],
		}),
		'send',
		'send_pal_message',
		'pending',
	)
	expect(palRecentActivity(thread)[0]).toMatchObject({
		status: 'working',
		detail: 'In progress',
	})
	expect(palRecentActivity({ ...thread, activeToolIds: [] })[0]).toMatchObject({
		status: 'stopped',
		detail: 'Stopped',
	})
	thread = call(thread, 'send', 'send_pal_message', 'failed')
	thread = call(thread, 'task', 'task_update', 'failed')
	expect(palRecentActivity(thread).map((row) => [row.title, row.status])).toEqual([
		['Update the plan', 'failed'],
		['Message to another Pal', 'failed'],
	])
	expect(palRecentActivity(thread).every((row) => row.detail === 'Couldn’t finish')).toBe(true)
})

it('removes successful plan bookkeeping from the card while retaining all technical receipts and newest action order', () => {
	let thread = emptyThread()
	for (let index = 0; index < 7; index++)
		thread = call(thread, `action-${index}`, 'read', 'completed')
	for (const title of ['task_create', 'task_update', 'task_list'])
		thread = call(thread, title, title, 'completed')
	const rows = palRecentActivity(thread)
	expect(rows.map((row) => thread.tools[row.id].toolCallId)).toEqual([
		'action-6',
		'action-5',
		'action-4',
		'action-3',
		'action-2',
	])
	expect(palToolActivity(thread)).toHaveLength(10)
})

it('uses a safe fallback for unrecognized and prototype-named tools, without parsing private presentations', () => {
	let thread = call(emptyThread(), 'plugin', 'mcp__private_service__operation', 'completed')
	thread = call(thread, 'prototype', 'toString', 'completed')
	expect(palRecentActivity(thread).map((row) => [row.title, row.detail])).toEqual([
		['Other action', 'Done'],
		['Other action', 'Done'],
	])
})

import { describe, expect, it, vi } from 'vitest'

import { ChildComposer, type ChildMessageAdmission, childComposerRows } from '../ChildComposer.js'
import { renderToScreen } from './support/screen.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

describe('the selected child message editor', () => {
	it('sends literal text once and reports queue admission without claiming it was read', async () => {
		const accepted = deferred<ChildMessageAdmission>()
		const called = deferred<void>()
		const send = vi.fn((text: string) => {
			called.resolve()
			return accepted.promise
		})
		const screen = await renderToScreen(
			<ChildComposer
				title="Reviewer"
				focused
				columns={98}
				onDraftChange={vi.fn()}
				onSubmit={send}
			/>,
		)
		try {
			screen.press('/effort quiet')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).not.toContain('Effort:')
			screen.press('\t')
			await screen.waitForRender()
			expect(send).not.toHaveBeenCalled()
			screen.press('\r')
			await called.promise
			screen.press('\r')
			expect(send.mock.calls).toEqual([['/effort quiet']])
			accepted.resolve({ kind: 'queued', taskId: 'task-original', state: 'running' })
			await accepted.promise
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain(
				'Message queued for the child’s next safe boundary.',
			)
		} finally {
			await screen.unmount()
		}
	})

	it('restores rejected input and can retry after an admission failure', async () => {
		const admission = deferred<ChildMessageAdmission>()
		const called = deferred<void>()
		const send = vi.fn(() => {
			called.resolve()
			return admission.promise
		})
		const screen = await renderToScreen(
			<ChildComposer
				title="Reviewer"
				focused
				columns={98}
				onDraftChange={vi.fn()}
				onSubmit={send}
			/>,
		)
		try {
			screen.press('keep this draft')
			await screen.waitForRender()
			screen.press('\r')
			await called.promise
			admission.reject(new Error('Current grants refuse this follow-up.'))
			await admission.promise.catch(() => {})
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('keep this draft')
			expect(screen.viewport().join('\n')).toContain('Current grants refuse this follow-up.')
			send.mockImplementationOnce(async () => ({
				kind: 'started',
				taskId: 'retry-task',
				state: 'pending',
			}))
			screen.press('\r')
			await screen.waitForRender()
			expect(send).toHaveBeenCalledTimes(2)
			expect(screen.viewport().join('\n')).toContain('New task accepted · pending.')
		} finally {
			await screen.unmount()
		}
	})

	it('preserves its draft while a permission screen owns input', async () => {
		const send = vi.fn(async () => ({
			kind: 'started' as const,
			taskId: 'task-new',
			state: 'pending',
		}))
		const onDraftChange = vi.fn()
		const editor = (hidden: boolean) => (
			<ChildComposer
				title="Reviewer"
				focused
				hidden={hidden}
				columns={98}
				onDraftChange={onDraftChange}
				onSubmit={send}
			/>
		)
		const screen = await renderToScreen(editor(false))
		try {
			screen.press('question for the child')
			await screen.waitForRender()
			screen.rerender(editor(true))
			await screen.waitForRender()
			screen.press('not child input\r')
			await screen.waitForRender()
			expect(send).not.toHaveBeenCalled()
			screen.rerender(editor(false))
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()
			expect(send.mock.calls).toEqual([['question for the child']])
			expect(screen.viewport().join('\n')).toContain('New task accepted · pending.')
		} finally {
			await screen.unmount()
		}
	})

	it('keeps an over-limit draft instead of sending or losing it', async () => {
		const send = vi.fn(async () => ({ kind: 'queued' as const, taskId: 'unused' }))
		const screen = await renderToScreen(
			<ChildComposer
				title="Reviewer"
				focused
				columns={98}
				draft={{ text: 'x'.repeat(16_001) }}
				onDraftChange={vi.fn()}
				onSubmit={send}
			/>,
		)
		try {
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()
			expect(send).not.toHaveBeenCalled()
			expect(screen.viewport().join('\n')).toContain('1–16000 characters')
		} finally {
			await screen.unmount()
		}
	})

	it('uses a compact editor in a short terminal', () => {
		expect(childComposerRows(14)).toBe(5)
		expect(childComposerRows(36)).toBe(8)
	})
})

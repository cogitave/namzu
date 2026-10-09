import { expect, it, vi } from 'vitest'
import {
	KEEP_WORKING,
	type MessageDialog,
	QUIT_AND_STOP,
	RunningReplyGuard,
	stopQuestion,
} from './running-reply-guard.js'

const dialogAnswering = (response: number) => {
	const showMessageBox = vi.fn(async () => ({ response }))
	return { dialog: { showMessageBox } satisfies MessageDialog, showMessageBox }
}

it('lets the app close without asking when nothing is running', async () => {
	const { dialog, showMessageBox } = dialogAnswering(KEEP_WORKING)
	await expect(new RunningReplyGuard(dialog, () => 0).confirm()).resolves.toBe(true)
	expect(showMessageBox).not.toHaveBeenCalled()
})

it('keeps the app open when the person chooses to keep working', async () => {
	const { dialog } = dialogAnswering(KEEP_WORKING)
	const guard = new RunningReplyGuard(dialog, () => 1)
	await expect(guard.confirm()).resolves.toBe(false)
	expect(guard.approved).toBe(false)
})

it('asks once, then remembers a yes so the quit that follows does not ask again', async () => {
	const { dialog, showMessageBox } = dialogAnswering(QUIT_AND_STOP)
	const guard = new RunningReplyGuard(dialog, () => 2)
	const [first, second] = await Promise.all([guard.confirm(), guard.confirm()])
	expect([first, second]).toEqual([true, true])
	await guard.confirm()
	expect(showMessageBox).toHaveBeenCalledTimes(1)
	expect(guard.approved).toBe(true)
})

it('says plainly what quitting does, with Keep working as the default', () => {
	const one = stopQuestion(1)
	expect(one.message).toBe('A reply is still running.')
	expect(one.detail).toContain('stopped because Namzu was closed')
	expect(one.buttons[one.defaultId]).toBe('Keep working')
	expect(stopQuestion(3).message).toBe('3 replies are still running.')
})

import { describe, expect, it } from 'vitest'
import { RecordingQuitGuard } from './quit-guard.js'

const dialogAnswering = (response: number) => {
	const asked: string[] = []
	return {
		asked,
		dialog: {
			async showMessageBox(options: { message: string }) {
				asked.push(options.message)
				return { response }
			},
		},
	}
}

describe('quitting with a recording', () => {
	it('does not ask when nothing is recorded', async () => {
		const { dialog, asked } = dialogAnswering(0)
		expect(await new RecordingQuitGuard(dialog, () => false).confirm()).toBe(true)
		expect(asked).toEqual([])
	})

	it('says the recording is lost, and stays open on the default answer', async () => {
		const { dialog, asked } = dialogAnswering(0)
		const guard = new RecordingQuitGuard(dialog, () => true)
		expect(await guard.confirm()).toBe(false)
		expect(asked).toEqual(['A screen recording is waiting. Quitting loses it.'])
		expect(guard.approved).toBe(false)
	})

	it('quits once the person agrees, and does not ask twice', async () => {
		const { dialog, asked } = dialogAnswering(1)
		const guard = new RecordingQuitGuard(dialog, () => true)
		expect(await guard.confirm()).toBe(true)
		expect(await guard.confirm()).toBe(true)
		expect(asked).toHaveLength(1)
	})
})

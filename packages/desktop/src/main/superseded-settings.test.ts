import { expect, it } from 'vitest'
import {
	ConversationHostChangedError,
	SUPERSEDED_READ_LIMIT,
	SupersededConversationSettingsError,
	readCurrent,
} from './superseded-settings.js'

function controlled() {
	let release = () => {}
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

it('reads again after the selection that overtook it settles, and answers with the fresh data', async () => {
	const selection = controlled()
	let reads = 0
	const result = readCurrent(
		async () => {
			reads++
			if (reads === 1) throw new SupersededConversationSettingsError()
			return `data ${reads}`
		},
		() => selection.promise,
	)
	selection.release()
	await expect(result).resolves.toBe('data 2')
	expect(reads).toBe(2)
})

it('waits for the selection instead of spinning while one is in flight', async () => {
	const selection = controlled()
	let reads = 0
	let order = ''
	const result = readCurrent(
		async () => {
			reads++
			order += 'r'
			if (reads === 1) throw new SupersededConversationSettingsError()
			return 'fresh'
		},
		() => {
			order += 'w'
			return selection.promise
		},
	)
	await Promise.resolve()
	await Promise.resolve()
	expect(order).toBe('rw')
	selection.release()
	await expect(result).resolves.toBe('fresh')
	expect(order).toBe('rwr')
})

it('retries a changed host once against the new host, then says so plainly', async () => {
	let reads = 0
	await expect(
		readCurrent(
			async () => {
				reads++
				if (reads === 1) throw new ConversationHostChangedError()
				return 'new host'
			},
			() => undefined,
		),
	).resolves.toBe('new host')
	let again = 0
	await expect(
		readCurrent(
			async () => {
				again++
				throw new ConversationHostChangedError()
			},
			() => undefined,
		),
	).rejects.toThrow('Namzu couldn’t load the settings for this conversation. Try again.')
	expect(again).toBe(2)
})

it('gives up with a plain sentence if newer selections keep overtaking it', async () => {
	let reads = 0
	const failure = await readCurrent(
		async () => {
			reads++
			throw new SupersededConversationSettingsError()
		},
		() => undefined,
	).catch((error: unknown) => error)
	expect(failure).toBeInstanceOf(ConversationHostChangedError)
	expect(reads).toBe(SUPERSEDED_READ_LIMIT + 1)
})

it('lets any other failure through untouched', async () => {
	const failure = new Error('Open this conversation first.')
	await expect(
		readCurrent(
			async () => {
				throw failure
			},
			() => undefined,
		),
	).rejects.toBe(failure)
})

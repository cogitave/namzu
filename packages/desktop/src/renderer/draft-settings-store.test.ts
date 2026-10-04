import { describe, expect, it, vi } from 'vitest'
import type { DraftSettings } from '../shared/protocol.js'
import { DraftSettingsStore } from './draft-settings-store.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

const choice: DraftSettings = {
	choice: { provider: 'codex-cli', model: 'actual-native-model' },
	options: { permissionMode: 'prompt', effort: 'high' },
}
const otherChoice: DraftSettings = {
	choice: { provider: 'zen', model: 'actual-provider-model' },
	options: { permissionMode: 'plan' },
}

describe('saved draft settings admission', () => {
	it('keeps a failed read unavailable and recovers the actual saved model on explicit retry', async () => {
		const failed = vi.fn()
		const changed = vi.fn()
		const read = vi
			.fn<() => Promise<DraftSettings>>()
			.mockRejectedValueOnce(new Error('IPC read failed'))
			.mockResolvedValueOnce(choice)
		const write = vi.fn<() => Promise<void>>()
		const store = new DraftSettingsStore(read, write, changed, failed)
		await store.load('session')
		expect(store.snapshot('session')).toEqual({
			value: undefined,
			loading: true,
			error: 'Saved message settings could not be loaded. Try again.',
		})
		expect(changed.mock.calls.every(([, snapshot]) => snapshot.value === undefined)).toBe(true)
		expect(failed).toHaveBeenCalledOnce()
		expect(write).not.toHaveBeenCalled()
		await store.retry('session')
		expect(store.snapshot('session')).toEqual({ value: choice, loading: false, error: undefined })
		expect(read).toHaveBeenCalledTimes(2)
	})
	it('accepts a successful empty draft without treating it as a read failure', async () => {
		const read = vi.fn(async () => ({}))
		const store = new DraftSettingsStore(
			read,
			async () => {},
			() => {},
			() => {},
		)
		await store.load('project:known')
		expect(store.snapshot('project:known')).toEqual({ value: {}, loading: false, error: undefined })
		await store.load('project:known')
		expect(read).toHaveBeenCalledOnce()
	})
	it('does not let an older read replace a newer explicit choice while its save is pending', async () => {
		const olderRead = deferred<DraftSettings>()
		const saved = deferred<void>()
		const store = new DraftSettingsStore(
			() => olderRead.promise,
			() => saved.promise,
			() => {},
			() => {},
		)
		const reading = store.load('session')
		const saving = store.save('session', choice)
		olderRead.resolve(otherChoice)
		await reading
		expect(store.get('session')).toEqual(choice)
		expect(store.snapshot('session').loading).toBe(true)
		saved.resolve()
		await saving
		expect(store.snapshot('session')).toEqual({ value: choice, loading: false, error: undefined })
	})
	it('retains an unconfirmed explicit choice after save failure and retries that write', async () => {
		const read = vi.fn(async () => otherChoice)
		const write = vi
			.fn<(_owner: string, _value: DraftSettings) => Promise<void>>()
			.mockRejectedValueOnce(new Error('IPC write failed'))
			.mockResolvedValueOnce(undefined)
		const store = new DraftSettingsStore(
			read,
			write,
			() => {},
			() => {},
		)
		await expect(store.save('session', choice)).rejects.toThrow('IPC write failed')
		expect(store.snapshot('session')).toEqual({
			value: choice,
			loading: true,
			error: 'Message settings could not be saved. Try again.',
		})
		await store.retry('session')
		expect(read).not.toHaveBeenCalled()
		expect(write.mock.calls.map(([, value]) => value)).toEqual([choice, choice])
		expect(store.snapshot('session')).toEqual({ value: choice, loading: false, error: undefined })
	})
	it('serializes owner writes after failure without rolling back a later model selection', async () => {
		const firstStarted = deferred<void>()
		const firstWrite = deferred<void>()
		const write = vi
			.fn<(_owner: string, _value: DraftSettings) => Promise<void>>()
			.mockImplementationOnce(() => {
				firstStarted.resolve()
				return firstWrite.promise
			})
			.mockResolvedValueOnce(undefined)
		const store = new DraftSettingsStore(
			async () => ({}),
			write,
			() => {},
			() => {},
		)
		await store.load('session')
		const savingFirst = store.save('session', choice)
		const firstRefused = expect(savingFirst).rejects.toThrow('first write failed')
		const savingSecond = store.save('session', otherChoice)
		await firstStarted.promise
		expect(write).toHaveBeenCalledTimes(1)
		expect(store.get('session')).toEqual(otherChoice)
		firstWrite.reject(new Error('first write failed'))
		await firstRefused
		await savingSecond
		expect(write.mock.calls.map(([, value]) => value)).toEqual([choice, otherChoice])
		expect(store.snapshot('session')).toEqual({
			value: otherChoice,
			loading: false,
			error: undefined,
		})
	})
	it('fences a cancelled owner read and prevents its late failure from affecting another project', async () => {
		const previous = deferred<DraftSettings>()
		const failed = vi.fn()
		const read = vi.fn((owner: string) =>
			owner === 'project:previous' ? previous.promise : Promise.resolve(choice),
		)
		const store = new DraftSettingsStore(
			read,
			async () => {},
			() => {},
			failed,
		)
		const older = store.load('project:previous')
		store.cancelRead('project:previous')
		await store.load('project:current')
		previous.reject(new Error('late read failure'))
		await older
		expect(failed).not.toHaveBeenCalled()
		expect(store.snapshot('project:previous')).toEqual({
			value: undefined,
			loading: true,
			error: undefined,
		})
		expect(store.snapshot('project:current')).toEqual({
			value: choice,
			loading: false,
			error: undefined,
		})
	})
})

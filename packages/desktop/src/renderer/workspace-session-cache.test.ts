import { describe, expect, it, vi } from 'vitest'
import { WorkspaceSessionCache } from './workspace-session-cache.js'

interface Metadata {
	provider: string
	model: string
	harness: 'namzu' | 'codex-cli'
}

const native: Metadata = {
	provider: 'codex-cli',
	model: 'confirmed-native-model',
	harness: 'codex-cli',
}
const sdk: Metadata = { provider: 'zen', model: 'confirmed-sdk-model', harness: 'namzu' }

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

describe('warm conversation metadata admission', () => {
	it('keeps a cold member unavailable until a successful admission and refuses unknown members', () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['owned'])
		expect(cache.read('owned', 'project')).toBeUndefined()
		expect(cache.current(cache.ticket('unknown', 'project'))).toBe(false)
		expect(cache.remember(cache.ticket('unknown', 'project'), native)).toBe(false)
		expect(cache.read('unknown', 'project')).toBeUndefined()
	})

	it('admits the exact confirmed metadata after the deferred cold request completes', async () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['owned'])
		const ticket = cache.ticket('owned', 'project')
		const response = deferred<Metadata>()
		const coldLoad = vi.fn(() => response.promise)
		const admission = coldLoad().then((value) => cache.remember(ticket, value))
		expect(cache.read('owned', 'project')).toBeUndefined()
		response.resolve(native)
		expect(await admission).toBe(true)
		expect(cache.read('owned', 'project')).toBe(native)
		expect(cache.read('owned', 'different-project')).toBeUndefined()
		expect(coldLoad).toHaveBeenCalledOnce()
	})

	it('does not admit a failed cold request or manufacture successful metadata for a retry', async () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['owned'])
		const ticket = cache.ticket('owned', 'project')
		const response = deferred<Metadata>()
		const admission = response.promise.then((value) => cache.remember(ticket, value))
		const rejected = expect(admission).rejects.toThrow('IPC metadata unavailable')
		response.reject(new Error('IPC metadata unavailable'))
		await rejected
		expect(cache.read('owned', 'project')).toBeUndefined()
		expect(cache.remember(cache.ticket('owned', 'project'), sdk)).toBe(true)
		expect(cache.read('owned', 'project')).toBe(sdk)
	})

	it('refuses an old in-flight result after a tab leaves and re-enters this pane', async () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['owned'])
		const oldTicket = cache.ticket('owned', 'project')
		cache.remember(oldTicket, sdk)
		const response = deferred<Metadata>()
		const admission = response.promise.then((value) => cache.remember(oldTicket, value))
		cache.synchronizeMembers([])
		cache.synchronizeMembers(['owned'])
		expect(cache.current(oldTicket)).toBe(false)
		expect(cache.read('owned', 'project')).toBeUndefined()
		response.resolve(native)
		expect(await admission).toBe(false)
		expect(cache.read('owned', 'project')).toBeUndefined()
		expect(cache.remember(cache.ticket('owned', 'project'), sdk)).toBe(true)
		expect(cache.read('owned', 'project')).toBe(sdk)
	})

	it('invalidates both warm state and in-flight reads when the project connection changes', async () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['owned'])
		const oldTicket = cache.ticket('owned', 'project')
		cache.remember(oldTicket, sdk)
		const response = deferred<Metadata>()
		const admission = response.promise.then((value) => cache.remember(oldTicket, value))
		cache.invalidateProject('project')
		expect(cache.current(oldTicket)).toBe(false)
		expect(cache.read('owned', 'project')).toBeUndefined()
		response.resolve(native)
		expect(await admission).toBe(false)
		expect(cache.remember(cache.ticket('owned', 'project'), sdk)).toBe(true)
		expect(cache.read('owned', 'project')).toBe(sdk)
	})

	it('retains admitted state for unrelated projects and unaffected pane members', () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['first', 'second', 'unrelated'])
		cache.remember(cache.ticket('first', 'project'), native)
		cache.remember(cache.ticket('second', 'project'), sdk)
		const unrelated = cache.ticket('unrelated', 'other-project')
		cache.remember(unrelated, native)
		cache.synchronizeMembers(['second', 'unrelated'])
		expect(cache.read('first', 'project')).toBeUndefined()
		expect(cache.read('second', 'project')).toBe(sdk)
		cache.invalidateProject('project')
		expect(cache.read('second', 'project')).toBeUndefined()
		expect(cache.current(unrelated)).toBe(true)
		expect(cache.read('unrelated', 'other-project')).toBe(native)
	})

	it('refuses an older explicit-choice result after forgetting only that session', async () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['changed', 'unaffected'])
		const oldTicket = cache.ticket('changed', 'project')
		cache.remember(oldTicket, native)
		cache.remember(cache.ticket('unaffected', 'project'), sdk)
		const response = deferred<Metadata>()
		const oldRead = response.promise.then((value) => cache.remember(oldTicket, value))
		cache.forget('changed')
		const selected = cache.ticket('changed', 'project')
		expect(cache.remember(selected, sdk)).toBe(true)
		response.resolve(native)
		expect(await oldRead).toBe(false)
		expect(cache.read('changed', 'project')).toBe(sdk)
		expect(cache.read('unaffected', 'project')).toBe(sdk)
	})

	it('fences admission until the choice ACK and rejects metadata read before or during it', async () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['changed', 'unaffected'])
		const before = cache.ticket('changed', 'project')
		cache.remember(before, native)
		cache.remember(cache.ticket('unaffected', 'project'), sdk)
		const finish = cache.beginMutation('changed')
		const during = cache.ticket('changed', 'project')
		const read = vi.fn(() => sdk)
		const activation = cache.whenSettled('changed').then(() => {
			const ticket = cache.ticket('changed', 'project')
			return cache.remember(ticket, read())
		})
		await cache.whenSettled('unaffected')
		expect(cache.mutating('changed')).toBe(true)
		expect(cache.current(before)).toBe(false)
		expect(cache.current(during)).toBe(false)
		expect(cache.read('changed', 'project')).toBeUndefined()
		expect(cache.read('unaffected', 'project')).toBe(sdk)
		expect(read).not.toHaveBeenCalled()
		finish()
		expect(await activation).toBe(true)
		expect(read).toHaveBeenCalledOnce()
		expect(cache.mutating('changed')).toBe(false)
		expect(cache.remember(before, native)).toBe(false)
		expect(cache.remember(during, native)).toBe(false)
		expect(cache.read('changed', 'project')).toBe(sdk)
	})

	it('keeps overlapping choices fenced until each settles and finishes each exactly once', async () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['changed'])
		const first = cache.beginMutation('changed')
		const second = cache.beginMutation('changed')
		const activated = vi.fn()
		const activation = cache.whenSettled('changed').then(activated)
		first()
		first()
		await Promise.resolve()
		expect(cache.mutating('changed')).toBe(true)
		expect(activated).not.toHaveBeenCalled()
		second()
		await activation
		expect(cache.mutating('changed')).toBe(false)
		expect(activated).toHaveBeenCalledOnce()
		expect(cache.remember(cache.ticket('changed', 'project'), sdk)).toBe(true)
		second()
		expect(cache.read('changed', 'project')).toBe(sdk)
	})

	it('waits for a replacement choice begun before an earlier waiter resumes', async () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['changed'])
		const first = cache.beginMutation('changed')
		const activated = vi.fn()
		const activation = cache.whenSettled('changed').then(activated)
		first()
		const replacement = cache.beginMutation('changed')
		await Promise.resolve()
		expect(activated).not.toHaveBeenCalled()
		expect(cache.mutating('changed')).toBe(true)
		replacement()
		await activation
		expect(activated).toHaveBeenCalledOnce()
	})

	it('settles a rejected choice in finally and admits only the subsequent authoritative read', async () => {
		const cache = new WorkspaceSessionCache<Metadata>()
		cache.synchronizeMembers(['changed'])
		const oldTicket = cache.ticket('changed', 'project')
		cache.remember(oldTicket, native)
		const ack = deferred<void>()
		const finish = cache.beginMutation('changed')
		const selection = ack.promise.finally(finish)
		const failed = expect(selection).rejects.toThrow('choice rejected')
		const reload = cache.whenSettled('changed').then(() => {
			return cache.remember(cache.ticket('changed', 'project'), sdk)
		})
		ack.reject(new Error('choice rejected'))
		await failed
		expect(await reload).toBe(true)
		expect(cache.mutating('changed')).toBe(false)
		expect(cache.remember(oldTicket, native)).toBe(false)
		expect(cache.read('changed', 'project')).toBe(sdk)
	})
})
